use serde::Deserialize;
use swc_core::common::{DUMMY_SP, Span, Spanned, SyntaxContext};
use swc_core::ecma::{
    ast::*,
    visit::{VisitMut, VisitMutWith},
};
use swc_core::plugin::{plugin_transform, proxies::TransformPluginProgramMetadata};

// Task 1.1: Plugin configuration
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginConfig {
    pub coverage_map_size: u32,
    pub trace_cmp: bool,
    pub coverage_global_name: String,
    pub trace_cmp_global_name: String,
}

impl Default for PluginConfig {
    fn default() -> Self {
        Self {
            coverage_map_size: 65536,
            trace_cmp: true,
            coverage_global_name: "__vitiate_cov".to_string(),
            trace_cmp_global_name: "__vitiate_trace_cmp".to_string(),
        }
    }
}

// Task 1.2: TransformVisitor with config and file path
pub struct TransformVisitor {
    config: PluginConfig,
    file_path: String,
}

impl TransformVisitor {
    pub fn new(mut config: PluginConfig, file_path: String) -> Self {
        if config.coverage_map_size == 0 {
            config.coverage_map_size = PluginConfig::default().coverage_map_size;
        }
        Self { config, file_path }
    }

    #[cfg(test)]
    pub fn default_for_test() -> Self {
        Self::new(PluginConfig::default(), "test.js".to_string())
    }

    // Task 1.3: Deterministic edge ID from file path + source span (FNV-1a)
    fn edge_id(&self, span: Span) -> u32 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for &byte in self.file_path.as_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        for &byte in &span.lo.0.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        for &byte in &span.hi.0.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        (hash as u32) % self.config.coverage_map_size
    }

    // Task 3.1: Build `__vitiate_cov[ID]++` as a statement
    fn make_counter_stmt(&self, span: Span) -> Stmt {
        Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(self.make_counter_expr(span)),
        })
    }

    // Build `__vitiate_cov[ID]++` as an expression
    fn make_counter_expr(&self, span: Span) -> Expr {
        let edge_id = self.edge_id(span);
        Expr::Update(UpdateExpr {
            span: DUMMY_SP,
            op: UpdateOp::PlusPlus,
            prefix: false,
            arg: Box::new(Expr::Member(MemberExpr {
                span: DUMMY_SP,
                obj: Box::new(Expr::Ident(Ident {
                    span: DUMMY_SP,
                    ctxt: SyntaxContext::empty(),
                    sym: self.config.coverage_global_name.as_str().into(),
                    optional: false,
                })),
                prop: MemberProp::Computed(ComputedPropName {
                    span: DUMMY_SP,
                    expr: Box::new(Expr::Lit(Lit::Num(Number {
                        span: DUMMY_SP,
                        value: edge_id as f64,
                        raw: None,
                    }))),
                }),
            })),
        })
    }

    // Task 3.2: Build `(__vitiate_cov[ID]++, expr)` as a comma expression
    fn wrap_with_counter(&self, span: Span, expr: Box<Expr>) -> Box<Expr> {
        Box::new(Expr::Seq(SeqExpr {
            span: DUMMY_SP,
            exprs: vec![Box::new(self.make_counter_expr(span)), expr],
        }))
    }

    // Ensure a statement is a block, wrapping if necessary
    fn ensure_block(stmt: &mut Box<Stmt>) {
        if !matches!(**stmt, Stmt::Block(_)) {
            let inner = std::mem::replace(&mut **stmt, Stmt::Empty(EmptyStmt { span: DUMMY_SP }));
            **stmt = Stmt::Block(BlockStmt {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                stmts: vec![inner],
            });
        }
    }

    // Prepend counter to a block statement
    fn prepend_counter_to_block(&self, block: &mut BlockStmt, span: Span) {
        block.stmts.insert(0, self.make_counter_stmt(span));
    }

    // Build preamble var declaration: `var <local> = globalThis.<global>;`
    fn make_preamble_stmt(&self, local_name: &str, global_name: &str) -> Stmt {
        Stmt::Decl(Decl::Var(Box::new(VarDecl {
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            kind: VarDeclKind::Var,
            declare: false,
            decls: vec![VarDeclarator {
                span: DUMMY_SP,
                name: Pat::Ident(BindingIdent {
                    id: Ident {
                        span: DUMMY_SP,
                        ctxt: SyntaxContext::empty(),
                        sym: local_name.into(),
                        optional: false,
                    },
                    type_ann: None,
                }),
                init: Some(Box::new(Expr::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: Box::new(Expr::Ident(Ident {
                        span: DUMMY_SP,
                        ctxt: SyntaxContext::empty(),
                        sym: "globalThis".into(),
                        optional: false,
                    })),
                    prop: MemberProp::Ident(IdentName {
                        span: DUMMY_SP,
                        sym: global_name.into(),
                    }),
                }))),
                definite: false,
            }],
        })))
    }

    // Build trace_cmp call: `__vitiate_trace_cmp(left, right, cmpId, "op")`
    fn make_trace_cmp_call(&self, left: Box<Expr>, right: Box<Expr>, span: Span, op: &str) -> Expr {
        let cmp_id = self.edge_id(span);
        Expr::Call(CallExpr {
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            callee: Callee::Expr(Box::new(Expr::Ident(Ident {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                sym: self.config.trace_cmp_global_name.as_str().into(),
                optional: false,
            }))),
            args: vec![
                ExprOrSpread {
                    spread: None,
                    expr: left,
                },
                ExprOrSpread {
                    spread: None,
                    expr: right,
                },
                ExprOrSpread {
                    spread: None,
                    expr: Box::new(Expr::Lit(Lit::Num(Number {
                        span: DUMMY_SP,
                        value: cmp_id as f64,
                        raw: None,
                    }))),
                },
                ExprOrSpread {
                    spread: None,
                    expr: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: op.into(),
                        raw: None,
                    }))),
                },
            ],
            type_args: None,
        })
    }

    // Check if a BinaryOp is a comparison operator
    fn is_comparison_op(op: BinaryOp) -> bool {
        matches!(
            op,
            BinaryOp::EqEqEq
                | BinaryOp::NotEqEq
                | BinaryOp::EqEq
                | BinaryOp::NotEq
                | BinaryOp::Lt
                | BinaryOp::Gt
                | BinaryOp::LtEq
                | BinaryOp::GtEq
        )
    }

    fn comparison_op_str(op: BinaryOp) -> &'static str {
        match op {
            BinaryOp::EqEqEq => "===",
            BinaryOp::NotEqEq => "!==",
            BinaryOp::EqEq => "==",
            BinaryOp::NotEq => "!=",
            BinaryOp::Lt => "<",
            BinaryOp::Gt => ">",
            BinaryOp::LtEq => "<=",
            BinaryOp::GtEq => ">=",
            // PANIC: only reachable via is_comparison_op() guard, which covers all arms above
            _ => unreachable!(),
        }
    }

    // Check if a BinaryOp is a logical operator
    fn is_logical_op(op: BinaryOp) -> bool {
        matches!(
            op,
            BinaryOp::LogicalAnd | BinaryOp::LogicalOr | BinaryOp::NullishCoalescing
        )
    }
}

impl VisitMut for TransformVisitor {
    // Task 2.1: Module preamble
    fn visit_mut_module(&mut self, module: &mut Module) {
        module.visit_mut_children_with(self);

        let cov_var = ModuleItem::Stmt(self.make_preamble_stmt(
            &self.config.coverage_global_name,
            &self.config.coverage_global_name,
        ));
        module.body.insert(0, cov_var);

        if self.config.trace_cmp {
            let trace_var = ModuleItem::Stmt(self.make_preamble_stmt(
                &self.config.trace_cmp_global_name,
                &self.config.trace_cmp_global_name,
            ));
            module.body.insert(1, trace_var);
        }
    }

    // Task 2.1: Script preamble (same as module, for non-module JS)
    fn visit_mut_script(&mut self, script: &mut Script) {
        script.visit_mut_children_with(self);

        let cov_var = self.make_preamble_stmt(
            &self.config.coverage_global_name,
            &self.config.coverage_global_name,
        );
        script.body.insert(0, cov_var);

        if self.config.trace_cmp {
            let trace_var = self.make_preamble_stmt(
                &self.config.trace_cmp_global_name,
                &self.config.trace_cmp_global_name,
            );
            script.body.insert(1, trace_var);
        }
    }

    // Tasks 5.1, 6.2: Binary expression - logical operators get edge counters
    // Comparison replacement is handled in visit_mut_expr
    fn visit_mut_bin_expr(&mut self, n: &mut BinExpr) {
        n.visit_mut_children_with(self);

        if Self::is_logical_op(n.op) {
            let right_span = n.right.span();
            let right = std::mem::replace(
                &mut n.right,
                Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
            );
            n.right = self.wrap_with_counter(right_span, right);
        }
        // Comparison operators are handled in visit_mut_expr
    }

    // Task 6.1: Comparison tracing - replace comparison BinExpr with trace_cmp call
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        if !self.config.trace_cmp {
            return;
        }
        if let Expr::Bin(bin) = expr
            && Self::is_comparison_op(bin.op)
        {
            let op_str = Self::comparison_op_str(bin.op);
            let span = bin.span;
            let left = std::mem::replace(
                &mut bin.left,
                Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
            );
            let right = std::mem::replace(
                &mut bin.right,
                Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
            );
            *expr = self.make_trace_cmp_call(left, right, span, op_str);
        }
    }

    // Task 3.3: If statement instrumentation
    fn visit_mut_if_stmt(&mut self, n: &mut IfStmt) {
        n.visit_mut_children_with(self);

        Self::ensure_block(&mut n.cons);
        let cons_span = n.cons.span();
        if let Stmt::Block(ref mut block) = *n.cons {
            self.prepend_counter_to_block(block, cons_span);
        }

        if let Some(ref mut alt) = n.alt {
            Self::ensure_block(alt);
            let alt_span = alt.span();
            if let Stmt::Block(ref mut block) = **alt {
                self.prepend_counter_to_block(block, alt_span);
            }
        }
    }

    // Task 3.7: Ternary expression instrumentation
    fn visit_mut_cond_expr(&mut self, n: &mut CondExpr) {
        n.visit_mut_children_with(self);

        let cons_span = n.cons.span();
        let alt_span = n.alt.span();
        let cons = std::mem::replace(
            &mut n.cons,
            Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
        );
        let alt = std::mem::replace(
            &mut n.alt,
            Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
        );
        n.cons = self.wrap_with_counter(cons_span, cons);
        n.alt = self.wrap_with_counter(alt_span, alt);
    }

    // Task 3.9: Switch case instrumentation
    fn visit_mut_switch_case(&mut self, n: &mut SwitchCase) {
        n.visit_mut_children_with(self);
        n.cons.insert(0, self.make_counter_stmt(n.span));
    }

    // Task 4.1: For loop
    fn visit_mut_for_stmt(&mut self, n: &mut ForStmt) {
        n.visit_mut_children_with(self);
        Self::ensure_block(&mut n.body);
        let body_span = n.body.span();
        if let Stmt::Block(ref mut block) = *n.body {
            self.prepend_counter_to_block(block, body_span);
        }
    }

    // Task 4.2: While loop
    fn visit_mut_while_stmt(&mut self, n: &mut WhileStmt) {
        n.visit_mut_children_with(self);
        Self::ensure_block(&mut n.body);
        let body_span = n.body.span();
        if let Stmt::Block(ref mut block) = *n.body {
            self.prepend_counter_to_block(block, body_span);
        }
    }

    // Task 4.3: Do-while loop
    fn visit_mut_do_while_stmt(&mut self, n: &mut DoWhileStmt) {
        n.visit_mut_children_with(self);
        Self::ensure_block(&mut n.body);
        let body_span = n.body.span();
        if let Stmt::Block(ref mut block) = *n.body {
            self.prepend_counter_to_block(block, body_span);
        }
    }

    // Task 4.4: For-in loop
    fn visit_mut_for_in_stmt(&mut self, n: &mut ForInStmt) {
        n.visit_mut_children_with(self);
        Self::ensure_block(&mut n.body);
        let body_span = n.body.span();
        if let Stmt::Block(ref mut block) = *n.body {
            self.prepend_counter_to_block(block, body_span);
        }
    }

    // Task 4.5: For-of loop
    fn visit_mut_for_of_stmt(&mut self, n: &mut ForOfStmt) {
        n.visit_mut_children_with(self);
        Self::ensure_block(&mut n.body);
        let body_span = n.body.span();
        if let Stmt::Block(ref mut block) = *n.body {
            self.prepend_counter_to_block(block, body_span);
        }
    }

    // Task 5.5: Catch clause
    fn visit_mut_catch_clause(&mut self, n: &mut CatchClause) {
        n.visit_mut_children_with(self);
        self.prepend_counter_to_block(&mut n.body, n.span);
    }

    // Finally block: insert an entry counter at the top of the finalizer block.
    // visit_mut_children_with fires the existing visit_mut_catch_clause for catch
    // blocks; only the finalizer needs explicit handling here.
    fn visit_mut_try_stmt(&mut self, n: &mut TryStmt) {
        n.visit_mut_children_with(self);
        if let Some(ref mut finalizer) = n.finalizer {
            let span = finalizer.span;
            self.prepend_counter_to_block(finalizer, span);
        }
    }

    // Short-circuit assignment operators (&&=, ||=, ??=) - the RHS is
    // conditionally evaluated (like logical binary ops), but these are
    // AssignExpr nodes, not BinExpr. Wrap the RHS in a comma expression
    // with an edge counter so the fuzzer sees the branch.
    fn visit_mut_assign_expr(&mut self, n: &mut AssignExpr) {
        n.visit_mut_children_with(self);

        if matches!(
            n.op,
            AssignOp::AndAssign | AssignOp::OrAssign | AssignOp::NullishAssign
        ) {
            let right_span = n.right.span();
            let right = std::mem::replace(
                &mut n.right,
                Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
            );
            n.right = self.wrap_with_counter(right_span, right);
        }
    }

    // Static class blocks: insert an entry counter at the top of the block.
    fn visit_mut_static_block(&mut self, n: &mut StaticBlock) {
        n.visit_mut_children_with(self);
        let span = n.body.span;
        self.prepend_counter_to_block(&mut n.body, span);
    }

    // Task 5.7: Function entry (function declarations, function expressions, methods)
    fn visit_mut_function(&mut self, n: &mut Function) {
        n.visit_mut_children_with(self);
        if let Some(ref mut body) = n.body {
            self.prepend_counter_to_block(body, n.span);
        }
    }

    // Task 5.7: Arrow function entry - block body gets prepended counter,
    // expression body gets wrapped in comma expression: () => (__vitiate_cov[ID]++, expr)
    fn visit_mut_arrow_expr(&mut self, n: &mut ArrowExpr) {
        n.visit_mut_children_with(self);
        // BlockStmtOrExpr is #[non_exhaustive] on the wasm32-wasip1 target,
        // so the wildcard arm is required for the release build.
        #[allow(unreachable_patterns)]
        match &mut *n.body {
            BlockStmtOrExpr::BlockStmt(block) => {
                self.prepend_counter_to_block(block, n.span);
            }
            BlockStmtOrExpr::Expr(expr) => {
                let span = expr.span();
                let orig =
                    std::mem::replace(expr, Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })));
                *expr = self.wrap_with_counter(span, orig);
            }
            _ => {}
        }
    }
}

// Task 1.4: Plugin entry point
#[plugin_transform]
pub fn process_transform(
    mut program: Program,
    metadata: TransformPluginProgramMetadata,
) -> Program {
    let config: PluginConfig = metadata
        .get_transform_plugin_config()
        .map(|json| {
            serde_json::from_str(&json)
                .unwrap_or_else(|e| panic!("vitiate-swc-plugin: invalid plugin config: {e}"))
        })
        .unwrap_or_default();

    let file_path = metadata
        .get_context(
            &swc_core::common::plugin::metadata::TransformPluginMetadataContextKind::Filename,
        )
        .unwrap_or_else(|| "unknown".to_string());

    let mut visitor = TransformVisitor::new(config, file_path);
    program.visit_mut_with(&mut visitor);
    program
}

#[cfg(test)]
mod tests {
    use super::*;
    use swc_core::common::{FileName, SourceMap, sync::Lrc};
    use swc_core::ecma::{
        codegen::{Emitter, text_writer::JsWriter},
        parser::{Parser, Syntax, lexer::Lexer},
        transforms::testing::test_inline,
        visit::visit_mut_pass,
    };

    fn test_visitor() -> TransformVisitor {
        TransformVisitor::default_for_test()
    }

    fn test_visitor_no_trace_cmp() -> TransformVisitor {
        let config = PluginConfig {
            trace_cmp: false,
            ..PluginConfig::default()
        };
        TransformVisitor::new(config, "test.js".to_string())
    }

    /// Parse input, apply transform, return printed output
    fn transform(input: &str, visitor: &mut TransformVisitor) -> String {
        let cm: Lrc<SourceMap> = Default::default();
        let fm = cm.new_source_file(FileName::Custom("test.js".into()).into(), input.to_string());
        let lexer = Lexer::new(Syntax::default(), Default::default(), (&*fm).into(), None);
        let mut parser = Parser::new_from(lexer);
        let mut program = parser.parse_program().expect("parse failed");
        program.visit_mut_with(visitor);

        let mut buf = Vec::new();
        {
            let mut emitter = Emitter {
                cfg: Default::default(),
                cm: cm.clone(),
                comments: None,
                wr: JsWriter::new(cm, "\n", &mut buf, None),
            };
            emitter.emit_program(&program).expect("emit failed");
        }
        String::from_utf8(buf).expect("utf8")
    }

    fn transform_default(input: &str) -> String {
        transform(input, &mut test_visitor())
    }

    fn transform_no_trace_cmp(input: &str) -> String {
        transform(input, &mut test_visitor_no_trace_cmp())
    }

    // ===== 2. Module Preamble =====

    // Task 2.2: Module preamble inserted before existing statements
    test_inline!(
        Default::default(),
        |_| visit_mut_pass(test_visitor()),
        preamble_before_existing,
        r#"console.log("hello");"#,
        r#"var __vitiate_cov = globalThis.__vitiate_cov;
var __vitiate_trace_cmp = globalThis.__vitiate_trace_cmp;
console.log("hello");"#
    );

    // Task 2.3: Empty module gets preamble only
    test_inline!(
        Default::default(),
        |_| visit_mut_pass(test_visitor()),
        preamble_empty_module,
        r#""#,
        r#"var __vitiate_cov = globalThis.__vitiate_cov;
var __vitiate_trace_cmp = globalThis.__vitiate_trace_cmp;"#
    );

    // ===== 3. Edge Coverage - Statements =====

    // Task 3.4: if/else - both branches get counters (exact output)
    #[test]
    fn if_else_both_branches() {
        let out = transform_no_trace_cmp(r#"if (c) { a(); } else { b(); }"#);
        // Verify counters in both consequent and alternate
        assert!(
            out.contains("__vitiate_cov[61710]++;\n    a();"),
            "missing counter in consequent: {out}"
        );
        assert!(
            out.contains("__vitiate_cov[9022]++;\n    b();"),
            "missing counter in alternate: {out}"
        );
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            2,
            "expected exactly 2 counters: {out}"
        );
    }

    // Task 3.5: if without else - consequent gets counter, no alternate synthesized
    #[test]
    fn if_no_else() {
        let out = transform_no_trace_cmp(r#"if (c) { a(); }"#);
        assert!(out.contains("__vitiate_cov["), "missing counter: {out}");
        assert!(!out.contains("else"), "should not synthesize else: {out}");
    }

    // Task 3.6: if without braces - consequent wrapped in block
    #[test]
    fn if_no_braces() {
        let out = transform_no_trace_cmp(r#"if (c) a();"#);
        assert!(out.contains("__vitiate_cov["), "missing counter: {out}");
        // The single statement should now be inside a block with the counter
        assert!(
            out.contains("{"),
            "consequent should be wrapped in block: {out}"
        );
    }

    // Task 3.8: ternary - both arms wrapped in comma expressions
    #[test]
    fn ternary_both_arms() {
        let out = transform_no_trace_cmp(r#"var x = c ? a : b;"#);
        // Verify comma expression wrapping shape: counter++, originalExpr
        assert!(
            out.contains("__vitiate_cov[28757]++, a"),
            "missing comma-wrapped consequent: {out}"
        );
        assert!(
            out.contains("__vitiate_cov[52981]++, b"),
            "missing comma-wrapped alternate: {out}"
        );
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            2,
            "expected exactly 2 counters: {out}"
        );
    }

    // Task 3.10: switch with cases and default
    #[test]
    fn switch_cases_and_default() {
        let out = transform_no_trace_cmp(
            r#"switch (x) { case 1: a(); break; case 2: b(); break; default: c(); }"#,
        );
        // 3 cases = 3 counters
        let counter_count = out.matches("__vitiate_cov[").count();
        assert!(
            counter_count >= 3,
            "expected >=3 counters for switch, got {counter_count}: {out}"
        );
    }

    // Task 3.11: switch with empty fall-through case
    #[test]
    fn switch_empty_fallthrough() {
        let out = transform_no_trace_cmp(r#"switch (x) { case 1: case 2: a(); break; }"#);
        // Even empty case gets a counter
        let counter_count = out.matches("__vitiate_cov[").count();
        assert!(
            counter_count >= 2,
            "expected >=2 counters for fallthrough, got {counter_count}: {out}"
        );
    }

    // ===== 4. Edge Coverage - Loops =====

    // Task 4.6: for loop body gets counter
    #[test]
    fn for_loop_counter() {
        let out = transform_no_trace_cmp(r#"for (let i = 0; i < n; i++) { a(); }"#);
        assert!(out.contains("__vitiate_cov["), "missing counter: {out}");
    }

    // Task 4.7: while loop without braces - body wrapped in block
    #[test]
    fn while_no_braces() {
        let out = transform_no_trace_cmp(r#"while (c) a();"#);
        assert!(out.contains("__vitiate_cov["), "missing counter: {out}");
        assert!(out.contains("{"), "body should be wrapped in block: {out}");
    }

    // Task 4.8: for-of loop body gets counter
    #[test]
    fn for_of_counter() {
        let out = transform_no_trace_cmp(r#"for (const x of items) { a(); }"#);
        assert!(out.contains("__vitiate_cov["), "missing counter: {out}");
    }

    // ===== 5. Edge Coverage - Logical Operators & Functions =====

    // Task 5.2: logical AND - rhs wrapped
    #[test]
    fn logical_and_rhs() {
        let out = transform_no_trace_cmp(r#"var x = a && b;"#);
        assert!(out.contains("__vitiate_cov["), "missing counter: {out}");
        // The counter should be in a comma expression with b
        assert!(out.contains(","), "expected comma expression: {out}");
    }

    // Task 5.3: nullish coalescing - rhs wrapped
    #[test]
    fn nullish_coalescing_rhs() {
        let out = transform_no_trace_cmp(r#"var x = a ?? b;"#);
        assert!(out.contains("__vitiate_cov["), "missing counter: {out}");
    }

    // Task 5.4: chained logical operators
    #[test]
    fn chained_logical_ops() {
        let out = transform_no_trace_cmp(r#"var x = a && b || c;"#);
        let counter_count = out.matches("__vitiate_cov[").count();
        assert!(
            counter_count >= 2,
            "expected >=2 counters for chained logical, got {counter_count}: {out}"
        );
    }

    // Task 5.6: try/catch - catch body gets counter
    #[test]
    fn try_catch_counter() {
        let out = transform_no_trace_cmp(r#"try { a(); } catch (e) { b(); }"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in catch: {out}"
        );
    }

    // Task 5.8: function declaration - body gets counter
    #[test]
    fn function_decl_counter() {
        let out = transform_no_trace_cmp(r#"function foo() { a(); }"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in function: {out}"
        );
    }

    // Task 5.9: arrow function with block body - body gets counter
    #[test]
    fn arrow_block_body_counter() {
        let out = transform_no_trace_cmp(r#"const f = () => { a(); };"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in arrow: {out}"
        );
    }

    // Task 5.10: arrow function with expression body - wrapped in comma expression
    #[test]
    fn arrow_expr_body_counter() {
        // Simple expression body
        let out = transform_no_trace_cmp(r#"const f = () => a;"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in arrow expr body: {out}"
        );
        assert!(
            out.contains(", a"),
            "expected comma expression wrapping: {out}"
        );

        // Object literal (parens disambiguate from block body)
        let out = transform_no_trace_cmp(r#"const f = () => ({ key: val });"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in arrow object literal body: {out}"
        );
    }

    // ===== 6. Comparison Tracing =====

    // Task 6.3: strict equality wrapped with trace_cmp
    #[test]
    fn trace_cmp_strict_eq() {
        let out = transform_default(r#"var x = a === b;"#);
        assert!(
            out.contains("__vitiate_trace_cmp("),
            "missing trace_cmp: {out}"
        );
        assert!(
            out.contains(r#""===""#),
            "missing === operator string: {out}"
        );
    }

    // Task 6.4: less-than wrapped with trace_cmp
    #[test]
    fn trace_cmp_less_than() {
        let out = transform_default(r#"var x = a < b;"#);
        assert!(
            out.contains("__vitiate_trace_cmp("),
            "missing trace_cmp: {out}"
        );
        assert!(out.contains(r#""<""#), "missing < operator string: {out}");
    }

    // Task 6.5: comparison inside logical - no double-instrumentation
    #[test]
    fn comparison_inside_logical() {
        let out = transform_default(r#"var x = a === b && c > d;"#);
        // Exactly 2 trace_cmp calls (one per comparison, no double-wrapping)
        assert_eq!(
            out.matches("__vitiate_trace_cmp(").count(),
            2,
            "expected exactly 2 trace_cmp: {out}"
        );
        // Exactly 1 edge counter (for the logical && rhs)
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            1,
            "expected exactly 1 edge counter: {out}"
        );
        // No raw === or > operators should remain (they're replaced by trace_cmp)
        assert!(!out.contains(" === "), "raw === should not remain: {out}");
    }

    // Task 6.6: arithmetic operators NOT wrapped
    #[test]
    fn arithmetic_not_wrapped() {
        let out = transform_default(r#"var x = a + b;"#);
        assert!(
            !out.contains("__vitiate_trace_cmp("),
            "arithmetic should not be wrapped: {out}"
        );
    }

    // Task 6.7: trace_cmp disabled via config - comparisons untouched
    #[test]
    fn trace_cmp_disabled() {
        let out = transform_no_trace_cmp(r#"var x = a === b;"#);
        assert!(
            !out.contains("__vitiate_trace_cmp("),
            "trace_cmp should be disabled: {out}"
        );
        assert!(out.contains("==="), "comparison should remain: {out}");
    }

    // ===== 7. Integration Tests =====

    // Task 7.1: nested constructs - if inside for inside function
    #[test]
    fn nested_constructs() {
        let out = transform_no_trace_cmp(
            r#"function foo() { for (var i = 0; i < n; i++) { if (i) { a(); } } }"#,
        );
        let counter_count = out.matches("__vitiate_cov[").count();
        // function entry + for body + if consequent = at least 3
        assert!(
            counter_count >= 3,
            "expected >=3 counters for nested constructs, got {counter_count}: {out}"
        );
    }

    // Task 7.2: full example - function with if/else, comparison tracing, and preamble
    #[test]
    fn full_example() {
        let out = transform_default(
            r#"function check(x) { if (x === 0) { return true; } else { return false; } }"#,
        );
        // Preamble
        assert!(
            out.contains("var __vitiate_cov = globalThis.__vitiate_cov"),
            "missing cov preamble: {out}"
        );
        assert!(
            out.contains("var __vitiate_trace_cmp = globalThis.__vitiate_trace_cmp"),
            "missing trace preamble: {out}"
        );
        // Comparison tracing
        assert!(
            out.contains("__vitiate_trace_cmp("),
            "missing trace_cmp: {out}"
        );
        assert!(out.contains(r#""===""#), "missing === op string: {out}");
        // Edge counters (function + if + else = at least 3)
        let counter_count = out.matches("__vitiate_cov[").count();
        assert!(
            counter_count >= 3,
            "expected >=3 counters, got {counter_count}: {out}"
        );
    }

    // ===== 8. Additional Coverage Tests =====

    // coverage_map_size = 0 should not panic (clamped to default in TransformVisitor::new)
    #[test]
    fn coverage_map_size_zero_no_panic() {
        let config = PluginConfig {
            coverage_map_size: 0,
            ..PluginConfig::default()
        };
        let mut visitor = TransformVisitor::new(config, "test.js".to_string());
        let out = transform(r#"if (c) { a(); }"#, &mut visitor);
        assert!(
            out.contains("__vitiate_cov["),
            "should still instrument: {out}"
        );
    }

    // trace_cmp=false omits the trace_cmp preamble
    #[test]
    fn trace_cmp_false_omits_preamble() {
        let out = transform_no_trace_cmp(r#"var x = 1;"#);
        assert!(
            out.contains("var __vitiate_cov = globalThis.__vitiate_cov"),
            "missing cov preamble: {out}"
        );
        assert!(
            !out.contains("__vitiate_trace_cmp"),
            "trace_cmp preamble should be omitted: {out}"
        );
    }

    // Class method gets function entry counter
    #[test]
    fn class_method_counter() {
        let out = transform_no_trace_cmp(r#"class Foo { bar() { a(); } }"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in class method: {out}"
        );
    }

    // Async function gets function entry counter
    #[test]
    fn async_function_counter() {
        let out = transform_no_trace_cmp(r#"async function foo() { await a(); }"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in async function: {out}"
        );
    }

    // Do-while loop body gets counter
    #[test]
    fn do_while_counter() {
        let out = transform_no_trace_cmp(r#"do { a(); } while (c);"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in do-while: {out}"
        );
    }

    // For-in loop body gets counter
    #[test]
    fn for_in_counter() {
        let out = transform_no_trace_cmp(r#"for (var k in obj) { a(); }"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in for-in: {out}"
        );
    }

    // Empty function body still gets counter
    #[test]
    fn empty_function_body_counter() {
        let out = transform_no_trace_cmp(r#"function foo() {}"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in empty function: {out}"
        );
    }

    // Else-if chain - each branch gets a counter, including the else-if edge itself
    #[test]
    fn else_if_chain() {
        let out = transform_no_trace_cmp(r#"if (a) { x(); } else if (b) { y(); } else { z(); }"#);
        let counter_count = out.matches("__vitiate_cov[").count();
        // if consequent + else-if edge + else-if consequent + else = at least 4
        assert!(
            counter_count >= 4,
            "expected >=4 counters for else-if chain, got {counter_count}: {out}"
        );
    }

    // Short-circuit assignment operators get edge counters on RHS
    #[test]
    fn short_circuit_assign_and() {
        let out = transform_no_trace_cmp(r#"x &&= expr;"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter for &&= RHS: {out}"
        );
        assert!(
            out.contains(", expr"),
            "expected comma expression wrapping: {out}"
        );
    }

    #[test]
    fn short_circuit_assign_or() {
        let out = transform_no_trace_cmp(r#"x ||= expr;"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter for ||= RHS: {out}"
        );
    }

    #[test]
    fn short_circuit_assign_nullish() {
        let out = transform_no_trace_cmp(r#"x ??= expr;"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter for ??= RHS: {out}"
        );
    }

    #[test]
    fn regular_assign_no_counter() {
        let out = transform_no_trace_cmp(r#"x = expr;"#);
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            0,
            "regular assignment should not get counter: {out}"
        );
    }

    // Static class blocks get entry counter
    #[test]
    fn static_block_counter() {
        let out = transform_no_trace_cmp(r#"class Foo { static { a(); } }"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in static block: {out}"
        );
    }

    #[test]
    fn empty_static_block_counter() {
        let out = transform_no_trace_cmp(r#"class Foo { static { } }"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in empty static block: {out}"
        );
    }

    // ===== Finally block instrumentation =====

    // try/finally without catch - finally gets counter
    #[test]
    fn try_finally_no_catch() {
        let out = transform_no_trace_cmp(r#"try { a(); } finally { b(); }"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in finally: {out}"
        );
    }

    // try/catch/finally - both catch and finally get counters
    #[test]
    fn try_catch_finally() {
        let out = transform_no_trace_cmp(r#"try { a(); } catch (e) { b(); } finally { c(); }"#);
        let counter_count = out.matches("__vitiate_cov[").count();
        assert!(
            counter_count >= 2,
            "expected >=2 counters (catch + finally), got {counter_count}: {out}"
        );
    }

    // Empty finally block still gets counter
    #[test]
    fn empty_finally_block() {
        let out = transform_no_trace_cmp(r#"try { a(); } finally { }"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in empty finally: {out}"
        );
    }

    // ===== Directive prologue handling =====

    // "use strict" directive: preamble should be inserted after directives.
    // SWC may strip "use strict" for modules (ESM is strict by default), but
    // it should be preserved in script mode. Since Vitiate runs via Vite's ESM
    // transform, this is primarily a correctness check.
    #[test]
    fn directive_prologue_module() {
        let out = transform_no_trace_cmp(r#""use strict"; console.log("hello");"#);
        // Preamble should be present
        assert!(
            out.contains("var __vitiate_cov = globalThis.__vitiate_cov"),
            "missing cov preamble: {out}"
        );
        // The preamble is inserted by visit_mut_module after children are visited.
        // SWC may strip the directive for modules; we just verify preamble is present
        // and code is intact.
        assert!(
            out.contains("console.log"),
            "original code should be preserved: {out}"
        );
    }

    // No directive: preamble at position 0
    #[test]
    fn no_directive_preamble_first() {
        let out = transform_no_trace_cmp(r#"console.log("hello");"#);
        let preamble_pos = out.find("var __vitiate_cov");
        let code_pos = out.find("console.log");
        assert!(preamble_pos.is_some(), "missing preamble: {out}");
        assert!(code_pos.is_some(), "missing code: {out}");
        assert!(
            preamble_pos.unwrap() < code_pos.unwrap(),
            "preamble should come before code: {out}"
        );
    }

    // ===== Additional test coverage =====

    // Generator function body gets counter
    #[test]
    fn generator_function_counter() {
        let out = transform_no_trace_cmp(r#"function* gen() { yield 1; }"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in generator function: {out}"
        );
    }

    // Async generator function body gets counter
    #[test]
    fn async_generator_function_counter() {
        let out = transform_no_trace_cmp(r#"async function* gen() { yield 1; }"#);
        assert!(
            out.contains("__vitiate_cov["),
            "missing counter in async generator function: {out}"
        );
    }

    // Complex nested comparisons
    #[test]
    fn complex_nested_comparisons() {
        let out = transform_default(r#"var x = a === b && c < d || e !== f;"#);
        // 3 comparisons should generate 3 trace_cmp calls
        assert_eq!(
            out.matches("__vitiate_trace_cmp(").count(),
            3,
            "expected 3 trace_cmp for 3 comparisons: {out}"
        );
        // 2 logical operators (&&, ||) should generate 2 edge counters
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            2,
            "expected 2 edge counters for logical ops: {out}"
        );
    }

    // Arrow expression body with comparison gets trace_cmp
    #[test]
    fn arrow_expr_body_with_comparison() {
        let out = transform_default(r#"const f = () => a === b;"#);
        assert!(
            out.contains("__vitiate_trace_cmp("),
            "missing trace_cmp in arrow expr: {out}"
        );
        // The raw `a === b` should be replaced; only "===" inside the string arg should remain
        assert!(
            !out.contains("a === b"),
            "raw comparison should be replaced: {out}"
        );
    }
}
