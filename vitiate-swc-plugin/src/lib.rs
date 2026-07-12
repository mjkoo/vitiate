use serde::Deserialize;
use swc_core::common::{DUMMY_SP, Span, Spanned, SyntaxContext};
use swc_core::ecma::{
    ast::*,
    visit::{VisitMut, VisitMutWith},
};
use swc_core::plugin::{plugin_transform, proxies::TransformPluginProgramMetadata};

/// Global the plugin accumulates per-file coverage-counter counts into, read by
/// the runtime to estimate coverage-map load. Must match the name the runtime
/// reads in `vitiate-core/src/globals.ts`.
const EDGE_COUNT_GLOBAL_NAME: &str = "__vitiate_edge_count";

// Task 1.1: Plugin configuration
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginConfig {
    pub coverage_map_size: u32,
    pub trace_cmp: bool,
    pub coverage_global_name: String,
    pub trace_cmp_global_name: String,
    /// Emit a call-site coverage counter before each call/`new` expression.
    /// Off by default; benchmark-gated (see the block-callsite-counters change).
    pub trace_calls: bool,
    /// Emit an inter-statement (basic-block) coverage counter between
    /// straight-line statements. Off by default; benchmark-gated.
    pub trace_stmt_blocks: bool,
}

impl Default for PluginConfig {
    fn default() -> Self {
        Self {
            coverage_map_size: 65536,
            trace_cmp: true,
            coverage_global_name: "__vitiate_cov".to_string(),
            trace_cmp_global_name: "__vitiate_cmplog_write".to_string(),
            trace_calls: false,
            trace_stmt_blocks: false,
        }
    }
}

/// Discriminates the kind of edge an id is computed for. Folded into the edge
/// hash so that edges sharing a source span (e.g. a loop's body-entry counter
/// and its synthesized loop-exit counter, or an if-consequent and its
/// synthesized not-taken else) never alias to the same coverage-map slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EdgeKind {
    /// A taken-path block-entry counter (the default for all existing probes).
    Block,
    /// The synthesized not-taken edge of an `if` with no `else`.
    ElseNotTaken,
    /// The synthesized fall-through edge past a loop.
    LoopExit,
    /// A comparison site recorded for CmpLog (indexes the cmplog buffer, not
    /// the coverage map).
    Cmp,
    /// A call-site counter (control reached a call/`new` expression). Optional,
    /// gated on `trace_calls`.
    Call,
    /// An inter-statement (basic-block) counter, fired only when the preceding
    /// statement completed normally. Optional, gated on `trace_stmt_blocks`.
    StmtBlock,
}

impl EdgeKind {
    fn discriminant(self) -> u64 {
        match self {
            EdgeKind::Block => 0,
            EdgeKind::ElseNotTaken => 1,
            EdgeKind::LoopExit => 2,
            EdgeKind::Cmp => 3,
            EdgeKind::Call => 4,
            EdgeKind::StmtBlock => 5,
        }
    }
}

// Task 1.2: TransformVisitor with config and file path
pub struct TransformVisitor {
    config: PluginConfig,
    file_path: String,
    /// Count of coverage-map counters emitted for this file. Injected into the
    /// preamble so the runtime can estimate coverage-map load (collision
    /// pressure). CmpLog sites are not counted (they index a separate buffer).
    edge_count: std::cell::Cell<u32>,
}

impl TransformVisitor {
    pub fn new(mut config: PluginConfig, file_path: String) -> Self {
        if config.coverage_map_size == 0 {
            config.coverage_map_size = PluginConfig::default().coverage_map_size;
        }
        Self {
            config,
            file_path,
            edge_count: std::cell::Cell::new(0),
        }
    }

    #[cfg(test)]
    pub fn default_for_test() -> Self {
        Self::new(PluginConfig::default(), "test.js".to_string())
    }

    // Task 1.3: Deterministic edge ID from file path + source span + edge kind.
    //
    // FNV-1a over (file_path, span.lo, span.hi, kind) followed by a murmur3
    // fmix64 avalanche finalizer. The finalizer matters because the map size is
    // typically a power of two, so the reduction `% size` keeps only the low
    // bits - and FNV-1a's low bits are weakly mixed. Avalanching first spreads
    // every input bit across the low bits, minimizing collisions (C5).
    fn edge_id(&self, span: Span, kind: EdgeKind) -> u32 {
        const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
        const FNV_PRIME: u64 = 0x0100_0000_01b3;

        let mut hash: u64 = FNV_OFFSET;
        let mut fold = |bytes: &[u8]| {
            for &byte in bytes {
                hash ^= byte as u64;
                hash = hash.wrapping_mul(FNV_PRIME);
            }
        };
        fold(self.file_path.as_bytes());
        fold(&span.lo.0.to_le_bytes());
        fold(&span.hi.0.to_le_bytes());
        fold(&kind.discriminant().to_le_bytes());

        // murmur3 fmix64 finalizer
        hash ^= hash >> 33;
        hash = hash.wrapping_mul(0xff51_afd7_ed55_8ccd);
        hash ^= hash >> 33;
        hash = hash.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
        hash ^= hash >> 33;

        (hash % self.config.coverage_map_size as u64) as u32
    }

    // Task 3.1: Build `__vitiate_cov[ID]++` as a statement
    fn make_counter_stmt(&self, span: Span, kind: EdgeKind) -> Stmt {
        Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(self.make_counter_expr(span, kind)),
        })
    }

    // Build `__vitiate_cov[ID]++` as an expression
    fn make_counter_expr(&self, span: Span, kind: EdgeKind) -> Expr {
        let edge_id = self.edge_id(span, kind);
        self.edge_count.set(self.edge_count.get() + 1);
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

    // Task 3.2: Build `(__vitiate_cov[ID]++, expr)` as a comma expression.
    // `kind` selects the edge kind so the same wrapper serves block-entry
    // probes (ternary arms, logical/short-circuit RHS, arrow expr bodies) and
    // optional call-site probes.
    fn wrap_with_counter(&self, span: Span, kind: EdgeKind, expr: Box<Expr>) -> Box<Expr> {
        Box::new(Expr::Seq(SeqExpr {
            span: DUMMY_SP,
            exprs: vec![Box::new(self.make_counter_expr(span, kind)), expr],
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

    // Prepend a block-entry counter to a block statement
    fn prepend_counter_to_block(&self, block: &mut BlockStmt, span: Span) {
        block
            .stmts
            .insert(0, self.make_counter_stmt(span, EdgeKind::Block));
    }

    /// If `stmt` is a loop (possibly wrapped in one or more labels), return the
    /// underlying loop's span; otherwise `None`. Used to place a loop-exit
    /// counter as the statement immediately after the loop. Peeling through
    /// `Stmt::Labeled` (rather than wrapping the loop) keeps labeled
    /// `continue`/`break` valid - wrapping a labeled loop in a block would make
    /// `continue label` target a non-iteration label (a syntax error).
    fn loop_exit_span(stmt: &Stmt) -> Option<Span> {
        let mut s = stmt;
        loop {
            match s {
                Stmt::For(l) => return Some(l.span),
                Stmt::While(l) => return Some(l.span),
                Stmt::DoWhile(l) => return Some(l.span),
                Stmt::ForIn(l) => return Some(l.span),
                Stmt::ForOf(l) => return Some(l.span),
                Stmt::Labeled(l) => s = &l.body,
                _ => return None,
            }
        }
    }

    /// Insert a loop-exit counter after each loop statement in a statement
    /// list. Shared by `visit_mut_stmts` (block/function/switch/script bodies)
    /// and `visit_mut_module_items` (module top level). The exit counter fires
    /// on normal fall-through past the loop, distinguishing "reached the loop
    /// but ran zero iterations / exited" from "never reached the loop".
    fn insert_loop_exit_counters<T>(
        &self,
        items: &mut Vec<T>,
        as_stmt: impl Fn(&T) -> Option<&Stmt>,
        wrap: impl Fn(Stmt) -> T,
    ) {
        let mut i = 0;
        while i < items.len() {
            let exit_span = as_stmt(&items[i]).and_then(Self::loop_exit_span);
            if let Some(span) = exit_span {
                let counter = self.make_counter_stmt(span, EdgeKind::LoopExit);
                items.insert(i + 1, wrap(counter));
                i += 2; // skip the counter we just inserted
            } else {
                i += 1;
            }
        }
    }

    /// A leading string-literal expression statement (a directive such as
    /// `"use strict"`). Only the leading run of these forms the directive
    /// prologue; inserting any other statement among them ends the prologue.
    fn is_directive(stmt: &Stmt) -> bool {
        matches!(stmt, Stmt::Expr(e) if matches!(&*e.expr, Expr::Lit(Lit::Str(_))))
    }

    /// A statement that unconditionally terminates straight-line flow in its
    /// enclosing list. Statements after one of these are unreachable, so no
    /// inter-statement counter is placed before them.
    fn is_terminator(stmt: &Stmt) -> bool {
        matches!(
            stmt,
            Stmt::Return(_) | Stmt::Throw(_) | Stmt::Break(_) | Stmt::Continue(_)
        )
    }

    /// Insert an inter-statement (basic-block) counter before each executable
    /// statement after the first in a statement list, so straight-line code
    /// splits into per-statement edges. Each counter fires only when the
    /// preceding statement completed normally (capturing call-return-vs-throw
    /// boundaries). Shared by `visit_mut_stmts` and `visit_mut_module_items`.
    ///
    /// Must run BEFORE `insert_loop_exit_counters` on the same list: it keys
    /// each counter on an original statement's span, and running it after
    /// loop-exit insertion would treat the synthesized (DUMMY_SP) loop-exit
    /// counters as statements and alias them all to `id(file, 0, 0)`.
    ///
    /// Hoisted `FunctionDecl`s are kept at the head (no counter before them);
    /// insertion stops once a terminating statement is seen. When
    /// `allow_directives` is set (module top level), a leading directive
    /// prologue is also kept at the head so its counters do not split it;
    /// nested blocks, loop/case bodies, etc. have no prologue, so their callers
    /// pass `false` and a leading string-literal statement is treated as an
    /// ordinary first statement.
    fn insert_stmt_block_counters<T>(
        &self,
        items: &mut Vec<T>,
        as_stmt: impl Fn(&T) -> Option<&Stmt>,
        wrap: impl Fn(Stmt) -> T,
        allow_directives: bool,
    ) {
        // Advance `start` to the first executable statement, keeping any
        // directive prologue (module level only), hoisted `FunctionDecl`s, and
        // non-statement items (imports/exports at module top level) at the
        // head. The first executable statement itself gets no counter (the
        // block-entry counter, where one exists, already covers reaching it),
        // so insertion begins at the following statement.
        let mut start = 0;
        while start < items.len() {
            match as_stmt(&items[start]) {
                Some(s) if allow_directives && Self::is_directive(s) => start += 1,
                Some(Stmt::Decl(Decl::Fn(_))) => start += 1,
                None => start += 1,
                _ => break,
            }
        }
        if start >= items.len() {
            return;
        }

        // `prev_term` tracks whether the previous *original* statement was a
        // terminator. It is read before inserting a counter for the current
        // statement, and never reads `items[i - 1]` (which becomes an inserted
        // counter after the first insertion).
        let mut prev_term = as_stmt(&items[start]).is_some_and(Self::is_terminator);
        let mut i = start + 1;
        while i < items.len() {
            if prev_term {
                break;
            }
            match as_stmt(&items[i]) {
                // Hoisted function declarations stay at the head: no counter
                // before them, and they do not terminate flow.
                Some(Stmt::Decl(Decl::Fn(_))) => {
                    prev_term = false;
                    i += 1;
                }
                Some(s) => {
                    let is_term = Self::is_terminator(s);
                    let span = s.span();
                    items.insert(i, wrap(self.make_counter_stmt(span, EdgeKind::StmtBlock)));
                    prev_term = is_term;
                    i += 2; // skip the counter we just inserted
                }
                // Non-statement items (imports/exports at module top level):
                // no counter, not a terminator.
                None => {
                    prev_term = false;
                    i += 1;
                }
            }
        }
    }

    /// Whether an expression is an ordinary call/`new`/optional-call site that
    /// should receive a call-site counter. `super(...)` and dynamic `import(...)`
    /// are excluded (wrapping them risks constructor init ordering / is not an
    /// ordinary call).
    fn is_instrumentable_call(expr: &Expr) -> bool {
        match expr {
            Expr::Call(c) => !matches!(c.callee, Callee::Super(_) | Callee::Import(_)),
            Expr::New(_) => true,
            Expr::OptChain(o) => matches!(&*o.base, OptChainBase::Call(_)),
            _ => false,
        }
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

    /// Build an IIFE-wrapped comparison with CmpLog recording:
    /// `((l, r) => (__vitiate_cmplog_write(l, r, cmpId, opId), l OP r))(left, right)`
    fn make_trace_cmp_call(
        &self,
        left: Box<Expr>,
        right: Box<Expr>,
        span: Span,
        op: BinaryOp,
    ) -> Expr {
        let cmp_id = self.edge_id(span, EdgeKind::Cmp);
        let op_id = Self::comparison_op_id(op);

        // Parameters: (l, r)
        let param_l = Pat::Ident(BindingIdent {
            id: Ident {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                sym: "l".into(),
                optional: false,
            },
            type_ann: None,
        });
        let param_r = Pat::Ident(BindingIdent {
            id: Ident {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                sym: "r".into(),
                optional: false,
            },
            type_ann: None,
        });

        // Ident references for l and r inside the IIFE body
        let ident_l = || {
            Box::new(Expr::Ident(Ident {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                sym: "l".into(),
                optional: false,
            }))
        };
        let ident_r = || {
            Box::new(Expr::Ident(Ident {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                sym: "r".into(),
                optional: false,
            }))
        };

        // __vitiate_cmplog_write(l, r, cmpId, opId)
        let record_call = Box::new(Expr::Call(CallExpr {
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
                    expr: ident_l(),
                },
                ExprOrSpread {
                    spread: None,
                    expr: ident_r(),
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
                    expr: Box::new(Expr::Lit(Lit::Num(Number {
                        span: DUMMY_SP,
                        value: op_id as f64,
                        raw: None,
                    }))),
                },
            ],
            type_args: None,
        }));

        // l OP r (preserves original span for source map fidelity)
        let comparison = Box::new(Expr::Bin(BinExpr {
            span,
            op,
            left: ident_l(),
            right: ident_r(),
        }));

        // (record(...), l OP r) - comma expression
        let body_expr = Box::new(Expr::Seq(SeqExpr {
            span: DUMMY_SP,
            exprs: vec![record_call, comparison],
        }));

        // (l, r) => (record(...), l OP r)
        let arrow = Expr::Arrow(ArrowExpr {
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            params: vec![param_l, param_r],
            body: Box::new(BlockStmtOrExpr::Expr(body_expr)),
            is_async: false,
            is_generator: false,
            type_params: None,
            return_type: None,
        });

        // ((l, r) => ...)(left, right)
        Expr::Call(CallExpr {
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            callee: Callee::Expr(Box::new(Expr::Paren(ParenExpr {
                span: DUMMY_SP,
                expr: Box::new(arrow),
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

    /// Map a comparison operator to its numeric ID for the CmpLog record function.
    ///
    /// The IDs must stay in sync with `CmpLogOperator::from_id()` in
    /// `vitiate-engine/src/cmplog.rs`. If you change this mapping, update
    /// both locations.
    fn comparison_op_id(op: BinaryOp) -> u8 {
        match op {
            BinaryOp::EqEqEq => 0,
            BinaryOp::NotEqEq => 1,
            BinaryOp::EqEq => 2,
            BinaryOp::NotEq => 3,
            BinaryOp::Lt => 4,
            BinaryOp::Gt => 5,
            BinaryOp::LtEq => 6,
            BinaryOp::GtEq => 7,
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

    /// Build `globalThis.__vitiate_edge_count = (globalThis.__vitiate_edge_count | 0) + N;`
    /// where N is the number of coverage counters emitted for this file. The
    /// `| 0` coerces the (possibly `undefined`) first-load value to 0. Summed
    /// across all loaded instrumented modules, this lets the runtime estimate
    /// coverage-map load (collision pressure) and warn if it is high (C5).
    fn make_edge_count_stmt(&self, count: u32) -> Stmt {
        let member = || MemberExpr {
            span: DUMMY_SP,
            obj: Box::new(Expr::Ident(Ident {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                sym: "globalThis".into(),
                optional: false,
            })),
            prop: MemberProp::Ident(IdentName {
                span: DUMMY_SP,
                sym: EDGE_COUNT_GLOBAL_NAME.into(),
            }),
        };
        let zero = || {
            Box::new(Expr::Lit(Lit::Num(Number {
                span: DUMMY_SP,
                value: 0.0,
                raw: None,
            })))
        };
        // (globalThis.__vitiate_edge_count | 0) - explicitly parenthesized so
        // it binds before the `+` (bitwise-or has lower precedence than `+`).
        let coerced = Expr::Paren(ParenExpr {
            span: DUMMY_SP,
            expr: Box::new(Expr::Bin(BinExpr {
                span: DUMMY_SP,
                op: BinaryOp::BitOr,
                left: Box::new(Expr::Member(member())),
                right: zero(),
            })),
        });
        // (... | 0) + N
        let sum = Expr::Bin(BinExpr {
            span: DUMMY_SP,
            op: BinaryOp::Add,
            left: Box::new(coerced),
            right: Box::new(Expr::Lit(Lit::Num(Number {
                span: DUMMY_SP,
                value: count as f64,
                raw: None,
            }))),
        });
        Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Assign(AssignExpr {
                span: DUMMY_SP,
                op: AssignOp::Assign,
                left: AssignTarget::Simple(SimpleAssignTarget::Member(member())),
                right: Box::new(sum),
            })),
        })
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

        // C5: record this file's coverage-counter count for the runtime's
        // collision-pressure estimate.
        let count = self.edge_count.get();
        if count > 0 {
            module
                .body
                .insert(0, ModuleItem::Stmt(self.make_edge_count_stmt(count)));
        }
    }

    // Module top-level loops live in `Vec<ModuleItem>`, which does NOT route
    // through visit_mut_stmts. Insert their loop-exit counters here.
    fn visit_mut_module_items(&mut self, items: &mut Vec<ModuleItem>) {
        items.visit_mut_children_with(self);
        // Statement-block counters must precede loop-exit insertion (see the
        // helper doc).
        if self.config.trace_stmt_blocks {
            // Module top level: a leading directive prologue is real, keep it.
            self.insert_stmt_block_counters(
                items,
                |item| match item {
                    ModuleItem::Stmt(s) => Some(s),
                    _ => None,
                },
                ModuleItem::Stmt,
                true,
            );
        }
        self.insert_loop_exit_counters(
            items,
            |item| match item {
                ModuleItem::Stmt(s) => Some(s),
                _ => None,
            },
            ModuleItem::Stmt,
        );
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

        let count = self.edge_count.get();
        if count > 0 {
            script.body.insert(0, self.make_edge_count_stmt(count));
        }
    }

    // Insert loop-exit counters after loops in every statement list (block,
    // function, switch-case, and script bodies). Module top level is handled by
    // visit_mut_module_items.
    fn visit_mut_stmts(&mut self, stmts: &mut Vec<Stmt>) {
        stmts.visit_mut_children_with(self);
        // Statement-block counters must precede loop-exit insertion (see the
        // helper doc).
        if self.config.trace_stmt_blocks {
            // Generic statement lists (function/script bodies, nested blocks,
            // loop/case bodies): no directive prologue to protect here - any
            // function/script-body directive is already demoted by the
            // entry-counter / preamble prepended elsewhere - so a leading
            // string literal is treated as an ordinary first statement.
            self.insert_stmt_block_counters(stmts, |s| Some(s), |s| s, false);
        }
        self.insert_loop_exit_counters(stmts, |s| Some(s), |s| s);
    }

    // Tasks 5.1, 6.2: Binary expression - logical operators get edge counters
    // Comparison replacement is handled in visit_mut_expr
    fn visit_mut_bin_expr(&mut self, n: &mut BinExpr) {
        // Capture the RHS span BEFORE descending: children may replace a
        // comparison/call RHS with a DUMMY_SP-spanned node (the CmpLog IIFE or
        // a call-site `(counter, call)` sequence), which would collapse the
        // short-circuit counter to id(file, 0, 0). Mirrors visit_mut_if_stmt.
        let right_span = n.right.span();
        n.visit_mut_children_with(self);

        if Self::is_logical_op(n.op) {
            let right = std::mem::replace(
                &mut n.right,
                Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
            );
            n.right = self.wrap_with_counter(right_span, EdgeKind::Block, right);
        }
        // Comparison operators are handled in visit_mut_expr
    }

    // Comparison tracing - wrap comparison BinExpr in IIFE with record call.
    // Optional call-site counters are applied here too (they need &mut Expr to
    // replace the call with a `(counter, call)` sequence).
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        // Comparison tracing: replace a comparison with the CmpLog IIFE and
        // return immediately, so the synthesized IIFE call is never itself
        // wrapped as a call site below.
        if self.config.trace_cmp
            && let Expr::Bin(bin) = expr
            && Self::is_comparison_op(bin.op)
        {
            let op = bin.op;
            let span = bin.span;
            let left = std::mem::replace(
                &mut bin.left,
                Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
            );
            let right = std::mem::replace(
                &mut bin.right,
                Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
            );
            *expr = self.make_trace_cmp_call(left, right, span, op);
            return;
        }

        // Call-site counters: wrap the whole call/`new`/optional-call in
        // `(__vitiate_cov[id]++, <call>)`. Wrapping the entire call (not just
        // the callee) preserves the `this` receiver and evaluation order.
        if self.config.trace_calls && Self::is_instrumentable_call(expr) {
            let span = expr.span();
            let orig = std::mem::replace(expr, Expr::Invalid(Invalid { span: DUMMY_SP }));
            *expr = *self.wrap_with_counter(span, EdgeKind::Call, Box::new(orig));
        }
    }

    // Task 3.3: If statement instrumentation
    fn visit_mut_if_stmt(&mut self, n: &mut IfStmt) {
        // Capture the original arm spans BEFORE ensure_block: it replaces a
        // braceless arm with a DUMMY_SP-spanned block, which would collide all
        // braceless branch counters at id(file, 0, 0).
        let cons_span = n.cons.span();
        let alt_span = n.alt.as_deref().map(|alt| alt.span());

        // Pre-order normalization: wrap arms into blocks BEFORE descending so a
        // braceless loop arm (`if (x) for (;;) f();`) lands in a real Vec<Stmt>
        // that visit_mut_stmts will traverse and give a loop-exit counter.
        Self::ensure_block(&mut n.cons);
        if let Some(ref mut alt) = n.alt {
            Self::ensure_block(alt);
        }

        n.visit_mut_children_with(self);

        if let Stmt::Block(ref mut block) = *n.cons {
            self.prepend_counter_to_block(block, cons_span);
        }

        match (&mut n.alt, alt_span) {
            (Some(alt), Some(alt_span)) => {
                if let Stmt::Block(ref mut block) = **alt {
                    self.prepend_counter_to_block(block, alt_span);
                }
            }
            (None, _) => {
                // else-less if: synthesize the not-taken edge as `else { c++ }`
                // so "reached the branch, condition false" is distinguishable
                // from "never reached the branch".
                n.alt = Some(Box::new(Stmt::Block(BlockStmt {
                    span: DUMMY_SP,
                    ctxt: SyntaxContext::empty(),
                    stmts: vec![self.make_counter_stmt(cons_span, EdgeKind::ElseNotTaken)],
                })));
            }
            _ => {}
        }
    }

    // Task 3.7: Ternary expression instrumentation
    fn visit_mut_cond_expr(&mut self, n: &mut CondExpr) {
        // Capture arm spans BEFORE descending: children may replace a
        // comparison/call arm with a DUMMY_SP-spanned node, which would
        // collapse both arm counters to id(file, 0, 0) (mirrors
        // visit_mut_if_stmt).
        let cons_span = n.cons.span();
        let alt_span = n.alt.span();
        n.visit_mut_children_with(self);

        let cons = std::mem::replace(
            &mut n.cons,
            Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
        );
        let alt = std::mem::replace(
            &mut n.alt,
            Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
        );
        n.cons = self.wrap_with_counter(cons_span, EdgeKind::Block, cons);
        n.alt = self.wrap_with_counter(alt_span, EdgeKind::Block, alt);
    }

    // Task 3.9: Switch case instrumentation
    fn visit_mut_switch_case(&mut self, n: &mut SwitchCase) {
        n.visit_mut_children_with(self);
        n.cons
            .insert(0, self.make_counter_stmt(n.span, EdgeKind::Block));
    }

    // Task 4.1: For loop
    fn visit_mut_for_stmt(&mut self, n: &mut ForStmt) {
        let body_span = n.body.span();
        Self::ensure_block(&mut n.body);
        n.visit_mut_children_with(self);
        if let Stmt::Block(ref mut block) = *n.body {
            self.prepend_counter_to_block(block, body_span);
        }
    }

    // Task 4.2: While loop
    fn visit_mut_while_stmt(&mut self, n: &mut WhileStmt) {
        let body_span = n.body.span();
        Self::ensure_block(&mut n.body);
        n.visit_mut_children_with(self);
        if let Stmt::Block(ref mut block) = *n.body {
            self.prepend_counter_to_block(block, body_span);
        }
    }

    // Task 4.3: Do-while loop
    fn visit_mut_do_while_stmt(&mut self, n: &mut DoWhileStmt) {
        let body_span = n.body.span();
        Self::ensure_block(&mut n.body);
        n.visit_mut_children_with(self);
        if let Stmt::Block(ref mut block) = *n.body {
            self.prepend_counter_to_block(block, body_span);
        }
    }

    // Task 4.4: For-in loop
    fn visit_mut_for_in_stmt(&mut self, n: &mut ForInStmt) {
        let body_span = n.body.span();
        Self::ensure_block(&mut n.body);
        n.visit_mut_children_with(self);
        if let Stmt::Block(ref mut block) = *n.body {
            self.prepend_counter_to_block(block, body_span);
        }
    }

    // Task 4.5: For-of loop
    fn visit_mut_for_of_stmt(&mut self, n: &mut ForOfStmt) {
        let body_span = n.body.span();
        Self::ensure_block(&mut n.body);
        n.visit_mut_children_with(self);
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
        // Capture the RHS span BEFORE descending (see visit_mut_bin_expr).
        let right_span = n.right.span();
        n.visit_mut_children_with(self);

        if matches!(
            n.op,
            AssignOp::AndAssign | AssignOp::OrAssign | AssignOp::NullishAssign
        ) {
            let right = std::mem::replace(
                &mut n.right,
                Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })),
            );
            n.right = self.wrap_with_counter(right_span, EdgeKind::Block, right);
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
        // Capture the expression-body span BEFORE descending: children may
        // replace a comparison/call body with a DUMMY_SP-spanned node (see
        // visit_mut_bin_expr). The body variant does not change during the
        // descent, so this stays valid for the Expr arm below.
        let expr_body_span = match &*n.body {
            BlockStmtOrExpr::Expr(expr) => Some(expr.span()),
            _ => None,
        };
        n.visit_mut_children_with(self);
        // BlockStmtOrExpr is #[non_exhaustive] on the wasm32-wasip1 target,
        // so the wildcard arm is required for the release build.
        #[allow(unreachable_patterns)]
        match &mut *n.body {
            BlockStmtOrExpr::BlockStmt(block) => {
                self.prepend_counter_to_block(block, n.span);
            }
            BlockStmtOrExpr::Expr(expr) => {
                let span = expr_body_span.unwrap_or_else(|| expr.span());
                let orig =
                    std::mem::replace(expr, Box::new(Expr::Invalid(Invalid { span: DUMMY_SP })));
                *expr = self.wrap_with_counter(span, EdgeKind::Block, orig);
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

    /// trace_cmp off (to isolate call counters from the comparison IIFE),
    /// trace_calls on.
    fn test_visitor_trace_calls() -> TransformVisitor {
        let config = PluginConfig {
            trace_cmp: false,
            trace_calls: true,
            ..PluginConfig::default()
        };
        TransformVisitor::new(config, "test.js".to_string())
    }

    /// trace_cmp off, trace_stmt_blocks on.
    fn test_visitor_trace_stmt_blocks() -> TransformVisitor {
        let config = PluginConfig {
            trace_cmp: false,
            trace_stmt_blocks: true,
            ..PluginConfig::default()
        };
        TransformVisitor::new(config, "test.js".to_string())
    }

    fn transform_trace_calls(input: &str) -> String {
        transform(input, &mut test_visitor_trace_calls())
    }

    fn transform_trace_stmt_blocks(input: &str) -> String {
        transform(input, &mut test_visitor_trace_stmt_blocks())
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
var __vitiate_cmplog_write = globalThis.__vitiate_cmplog_write;
console.log("hello");"#
    );

    // Task 2.3: Empty module gets preamble only
    test_inline!(
        Default::default(),
        |_| visit_mut_pass(test_visitor()),
        preamble_empty_module,
        r#""#,
        r#"var __vitiate_cov = globalThis.__vitiate_cov;
var __vitiate_cmplog_write = globalThis.__vitiate_cmplog_write;"#
    );

    // ===== 3. Edge Coverage - Statements =====

    // Task 3.4: if/else - both branches get counters (exact output)
    #[test]
    fn if_else_both_branches() {
        let out = transform_no_trace_cmp(r#"if (c) { a(); } else { b(); }"#);
        // Verify counters in both consequent and alternate
        assert!(
            out.contains("__vitiate_cov[14991]++;\n    a();"),
            "missing counter in consequent: {out}"
        );
        assert!(
            out.contains("__vitiate_cov[10582]++;\n    b();"),
            "missing counter in alternate: {out}"
        );
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            2,
            "expected exactly 2 counters: {out}"
        );
    }

    // Task 3.5 / C1: if without else - consequent gets a counter AND a not-taken
    // else counter is synthesized so "condition false" is distinguishable from
    // "branch not reached".
    #[test]
    fn if_no_else() {
        let out = transform_no_trace_cmp(r#"if (c) { a(); }"#);
        // A synthetic `else { __vitiate_cov[..]++ }` is now emitted.
        assert!(
            out.contains("else"),
            "should synthesize not-taken else: {out}"
        );
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            2,
            "expected consequent + synthesized not-taken counter: {out}"
        );
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
            out.contains("__vitiate_cov[9790]++, a"),
            "missing comma-wrapped consequent: {out}"
        );
        assert!(
            out.contains("__vitiate_cov[17503]++, b"),
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

    // Strict equality emits IIFE with numeric operator ID 0
    #[test]
    fn trace_cmp_strict_eq() {
        let out = transform_default(r#"var x = a === b;"#);
        assert!(
            out.contains("__vitiate_cmplog_write("),
            "missing trace_cmp record call: {out}"
        );
        // IIFE should preserve the original === comparison in the body
        assert!(
            out.contains("l === r"),
            "missing l === r in IIFE body: {out}"
        );
        // Numeric operator ID (0 for ===), not a string
        assert!(
            !out.contains(r#""===""#),
            "should not contain string operator: {out}"
        );
    }

    // Less-than emits IIFE with numeric operator ID 4
    #[test]
    fn trace_cmp_less_than() {
        let out = transform_default(r#"var x = a < b;"#);
        assert!(
            out.contains("__vitiate_cmplog_write("),
            "missing trace_cmp record call: {out}"
        );
        // IIFE should preserve the original < comparison in the body
        assert!(out.contains("l < r"), "missing l < r in IIFE body: {out}");
    }

    // Comparison inside logical - no double-instrumentation
    #[test]
    fn comparison_inside_logical() {
        let out = transform_default(r#"var x = a === b && c > d;"#);
        // Exactly 2 trace_cmp record calls (one per comparison, no double-wrapping)
        assert_eq!(
            out.matches("__vitiate_cmplog_write(").count(),
            2,
            "expected exactly 2 trace_cmp: {out}"
        );
        // Exactly 1 edge counter (for the logical && rhs)
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            1,
            "expected exactly 1 edge counter: {out}"
        );
        // The comparisons are preserved in the IIFE bodies
        assert!(out.contains("l === r"), "missing l === r in IIFE: {out}");
        assert!(out.contains("l > r"), "missing l > r in IIFE: {out}");
    }

    // Task 6.6: arithmetic operators NOT wrapped
    #[test]
    fn arithmetic_not_wrapped() {
        let out = transform_default(r#"var x = a + b;"#);
        assert!(
            !out.contains("__vitiate_cmplog_write("),
            "arithmetic should not be wrapped: {out}"
        );
    }

    // Task 6.7: trace_cmp disabled via config - comparisons untouched
    #[test]
    fn trace_cmp_disabled() {
        let out = transform_no_trace_cmp(r#"var x = a === b;"#);
        assert!(
            !out.contains("__vitiate_cmplog_write("),
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

    // Full example - function with if/else, comparison tracing IIFE, and preamble
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
            out.contains("var __vitiate_cmplog_write = globalThis.__vitiate_cmplog_write"),
            "missing trace preamble: {out}"
        );
        // Comparison tracing IIFE
        assert!(
            out.contains("__vitiate_cmplog_write("),
            "missing trace_cmp record call: {out}"
        );
        assert!(
            out.contains("l === r"),
            "missing l === r in IIFE body: {out}"
        );
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
            !out.contains("__vitiate_cmplog_write"),
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
            out.matches("__vitiate_cmplog_write(").count(),
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

    // Custom traceCmpGlobalName is used in preamble and IIFE bodies
    #[test]
    fn custom_trace_cmp_global_name() {
        let config = PluginConfig {
            trace_cmp_global_name: "__my_record".to_string(),
            ..PluginConfig::default()
        };
        let mut visitor = TransformVisitor::new(config, "test.js".to_string());
        let out = transform(r#"var x = a === b;"#, &mut visitor);
        assert!(
            out.contains("var __my_record = globalThis.__my_record"),
            "preamble should use custom name: {out}"
        );
        assert!(
            out.contains("__my_record("),
            "IIFE record call should use custom name: {out}"
        );
        assert!(
            !out.contains("__vitiate_cmplog_write"),
            "default name should not appear: {out}"
        );
    }

    // Nested comparison where one comparison's result is an operand of another
    #[test]
    fn nested_comparison_as_operand() {
        let out = transform_default(r#"var x = (a < b) === (c > d);"#);
        // 3 comparisons: a < b, c > d, and the outer ===
        assert_eq!(
            out.matches("__vitiate_cmplog_write(").count(),
            3,
            "expected 3 trace_cmp for 3 comparisons: {out}"
        );
        // Each comparison preserved in its own IIFE body
        assert!(out.contains("l < r"), "missing l < r in IIFE body: {out}");
        assert!(out.contains("l > r"), "missing l > r in IIFE body: {out}");
        assert!(
            out.contains("l === r"),
            "missing l === r in IIFE body: {out}"
        );
    }

    // Arrow expression body with comparison gets IIFE-wrapped trace_cmp
    #[test]
    fn arrow_expr_body_with_comparison() {
        let out = transform_default(r#"const f = () => a === b;"#);
        assert!(
            out.contains("__vitiate_cmplog_write("),
            "missing trace_cmp in arrow expr: {out}"
        );
        // The original `a === b` is replaced by an IIFE; `a` and `b` become
        // IIFE arguments, and `l === r` appears in the IIFE body.
        assert!(
            !out.contains("a === b"),
            "raw comparison should be replaced: {out}"
        );
        assert!(
            out.contains("l === r"),
            "missing l === r in IIFE body: {out}"
        );
    }

    // ===== C1: not-taken / loop-exit edges; C5: hash mixing =====

    // Edge-kind discriminant: the same span with different kinds yields distinct
    // ids, so a loop's body-entry and loop-exit counters never alias in the map.
    #[test]
    fn edge_kind_discriminates_ids() {
        let v = test_visitor();
        let block = v.edge_id(DUMMY_SP, EdgeKind::Block);
        let else_nt = v.edge_id(DUMMY_SP, EdgeKind::ElseNotTaken);
        let loop_exit = v.edge_id(DUMMY_SP, EdgeKind::LoopExit);
        let cmp = v.edge_id(DUMMY_SP, EdgeKind::Cmp);
        assert_ne!(block, else_nt);
        assert_ne!(block, loop_exit);
        assert_ne!(block, cmp);
        assert_ne!(else_nt, loop_exit);
        assert_ne!(else_nt, cmp);
        assert_ne!(loop_exit, cmp);
    }

    // Each loop kind gets a loop-exit counter after the loop (body-entry + exit).
    #[test]
    fn for_loop_exit_counter() {
        let out = transform_no_trace_cmp(r#"for (let i = 0; i < n; i++) { a(); }"#);
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            2,
            "expected body-entry + loop-exit counter: {out}"
        );
    }

    #[test]
    fn while_loop_exit_counter() {
        let out = transform_no_trace_cmp(r#"while (c) { a(); }"#);
        assert_eq!(out.matches("__vitiate_cov[").count(), 2, "{out}");
    }

    #[test]
    fn do_while_loop_exit_counter() {
        let out = transform_no_trace_cmp(r#"do { a(); } while (c);"#);
        assert_eq!(out.matches("__vitiate_cov[").count(), 2, "{out}");
    }

    #[test]
    fn for_of_loop_exit_counter() {
        let out = transform_no_trace_cmp(r#"for (const x of xs) { a(); }"#);
        assert_eq!(out.matches("__vitiate_cov[").count(), 2, "{out}");
    }

    #[test]
    fn for_in_loop_exit_counter() {
        let out = transform_no_trace_cmp(r#"for (const k in o) { a(); }"#);
        assert_eq!(out.matches("__vitiate_cov[").count(), 2, "{out}");
    }

    // Labeled loop: `continue`/`break` to the label stay valid (the loop is not
    // wrapped in a block) and exactly one loop-exit counter is inserted.
    #[test]
    fn labeled_loop_exit_counter() {
        let out = transform_no_trace_cmp(r#"outer: for(;;){ continue outer; }"#);
        assert!(
            out.contains("continue outer"),
            "labeled continue must be preserved: {out}"
        );
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            2,
            "expected body-entry + one loop-exit counter: {out}"
        );
    }

    // Nested braceless loops: BOTH inner and outer get body-entry + loop-exit
    // counters (the inner loop must not escape instrumentation).
    #[test]
    fn nested_braceless_loops_exit_counters() {
        let out = transform_no_trace_cmp(r#"for(;;) for(;;) a();"#);
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            4,
            "expected body-entry + loop-exit for both nested loops: {out}"
        );
    }

    // Module top-level loop lives in Vec<ModuleItem>, not Vec<Stmt> - it must
    // still get a loop-exit counter (via visit_mut_module_items).
    #[test]
    fn module_top_level_loop_exit_counter() {
        // `export` forces Module parsing.
        let out = transform_no_trace_cmp(r#"export const z = 1; for (const y of ys) { a(); }"#);
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            2,
            "module top-level loop missing exit counter: {out}"
        );
    }

    // C5: per-file edge-count accumulator injected, correctly parenthesized so
    // `(x | 0) + N` binds as intended (not `x | (0 + N)`).
    #[test]
    fn edge_count_accumulator_injected() {
        // if consequent + synthesized not-taken else = 2 counters.
        let out = transform_no_trace_cmp(r#"if (c) { a(); }"#);
        assert!(
            out.contains("(globalThis.__vitiate_edge_count | 0) + 2"),
            "edge-count accumulator missing or mis-parenthesized: {out}"
        );
    }

    // No coverage counters -> no edge-count accumulator.
    #[test]
    fn edge_count_not_injected_when_uninstrumented() {
        let out = transform_no_trace_cmp(r#"var x = 1;"#);
        assert!(
            !out.contains("__vitiate_edge_count"),
            "should not inject accumulator for uninstrumented file: {out}"
        );
    }

    // Infinite loop still emits a (dead but harmless) loop-exit counter without
    // breaking codegen.
    #[test]
    fn infinite_loop_exit_counter_harmless() {
        let out = transform_no_trace_cmp(r#"while(true){ a(); }"#);
        assert_eq!(out.matches("__vitiate_cov[").count(), 2, "{out}");
    }

    // A loop inside a switch case still gets a loop-exit counter (the case's
    // statement list routes through visit_mut_stmts).
    #[test]
    fn loop_in_switch_case_exit_counter() {
        let out = transform_no_trace_cmp(r#"switch(x){ case 1: while(c){ a(); } break; }"#);
        // case entry + while body-entry + while loop-exit = 3
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            3,
            "loop in switch case missing exit counter: {out}"
        );
    }

    // Loops inside try / catch / finally blocks each get a loop-exit counter.
    #[test]
    fn loop_in_try_blocks_exit_counters() {
        let out = transform_no_trace_cmp(
            r#"try { for(;;){ a(); } } catch(e) { while(c){ b(); } } finally { do { d(); } while(c); }"#,
        );
        // 3 loops x (body-entry + loop-exit) = 6, plus catch-entry + finally-entry = 8
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            8,
            "loops in try blocks missing exit counters: {out}"
        );
    }

    // ===== Call-site counters (trace_calls) =====

    // An ordinary call is wrapped in `(counter, call)`.
    #[test]
    fn call_site_ordinary_call_wrapped() {
        let out = transform_trace_calls(r#"foo(a, b);"#);
        assert!(
            out.contains("__vitiate_cov[") && out.contains(", foo(a, b)"),
            "call not wrapped: {out}"
        );
        assert_eq!(out.matches("__vitiate_cov[").count(), 1, "{out}");
    }

    // A method call keeps its receiver: the WHOLE call is wrapped, not the
    // callee, so `this` is preserved.
    #[test]
    fn call_site_method_call_preserves_receiver() {
        let out = transform_trace_calls(r#"obj.method(x);"#);
        assert!(
            out.contains(", obj.method(x)"),
            "method receiver not preserved (callee wrapped in isolation?): {out}"
        );
        assert_eq!(out.matches("__vitiate_cov[").count(), 1, "{out}");
    }

    // `new` expressions are instrumented.
    #[test]
    fn call_site_new_expression_wrapped() {
        let out = transform_trace_calls(r#"new Foo(x);"#);
        assert!(out.contains(", new Foo(x)"), "new not wrapped: {out}");
        assert_eq!(out.matches("__vitiate_cov[").count(), 1, "{out}");
    }

    // `super(...)` is not wrapped (only the constructor entry counter remains).
    #[test]
    fn call_site_super_call_skipped() {
        let out = transform_trace_calls(r#"class B extends A { constructor(){ super(); } }"#);
        assert!(
            !out.contains(", super("),
            "super() must not be wrapped: {out}"
        );
        // super() is skipped and constructors get no entry counter, so no
        // coverage counter is emitted at all.
        assert_eq!(out.matches("__vitiate_cov[").count(), 0, "{out}");
    }

    // Dynamic `import(...)` is not wrapped.
    #[test]
    fn call_site_dynamic_import_skipped() {
        let out = transform_trace_calls(r#"import(y);"#);
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            0,
            "dynamic import must not be instrumented: {out}"
        );
    }

    // Optional-chaining calls are wrapped whole.
    #[test]
    fn call_site_optional_chain_call_wrapped() {
        let out = transform_trace_calls(r#"a?.b();"#);
        assert!(out.contains(", a?.b()"), "optional call not wrapped: {out}");
        assert_eq!(out.matches("__vitiate_cov[").count(), 1, "{out}");
    }

    // Nested calls each get their own counter; the receiver of the outer call
    // stays correct.
    #[test]
    fn call_site_nested_calls_each_counted() {
        let out = transform_trace_calls(r#"a.b().c();"#);
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            2,
            "expected one counter per call site: {out}"
        );
    }

    // Disabled by default: no call-site counters without the flag.
    #[test]
    fn call_site_disabled_by_default() {
        let out = transform_no_trace_cmp(r#"foo(a, b);"#);
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            0,
            "no call counter should be emitted by default: {out}"
        );
    }

    // The synthesized CmpLog IIFE is not itself wrapped as a call site when
    // both trace_cmp and trace_calls are on (no __vitiate_cov counter appears;
    // the comparison records via __vitiate_cmplog_write only).
    #[test]
    fn call_site_does_not_wrap_cmplog_iife() {
        let config = PluginConfig {
            trace_cmp: true,
            trace_calls: true,
            ..PluginConfig::default()
        };
        let out = transform(
            r#"var x = a === b;"#,
            &mut TransformVisitor::new(config, "test.js".to_string()),
        );
        assert!(
            out.contains("__vitiate_cmplog_write("),
            "comparison should still be traced: {out}"
        );
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            0,
            "the synthesized CmpLog IIFE must not receive a call-site counter: {out}"
        );
    }

    // ===== Statement-block counters (trace_stmt_blocks) =====

    // Straight-line statements split into per-statement edges (entry + N-1
    // inter-statement counters).
    #[test]
    fn stmt_block_splits_straight_line() {
        let out = transform_trace_stmt_blocks(r#"function f(){ a(); b(); c(); }"#);
        // function entry + 2 inter-statement counters = 3
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            3,
            "expected entry + 2 inter-statement counters: {out}"
        );
    }

    // Module top-level (module-item list) is covered too. An import forces the
    // Module (not Script) parse, routing through visit_mut_module_items.
    #[test]
    fn stmt_block_module_top_level() {
        let out = transform_trace_stmt_blocks(r#"import x from "y"; a(); b();"#);
        // no entry counter at module top level; one counter before b()
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            1,
            "expected exactly one inter-statement counter before b(): {out}"
        );
    }

    // At MODULE top level a multi-directive prologue is not split, and the
    // first executable statement is not counted (only the second gets a
    // counter). The `import` forces the Module parse (module-item path, where
    // directive protection applies).
    #[test]
    fn stmt_block_directive_prologue_not_split_module() {
        let out =
            transform_trace_stmt_blocks(r#""use strict"; "use other"; import "y"; a(); b();"#);
        assert!(out.contains("\"use strict\""), "{out}");
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            1,
            "prologue split or first executable counted: {out}"
        );
    }

    // Directive protection is scoped to the module prologue: a leading
    // string-literal statement in a generic statement list (here a nested
    // block, the Script path) is treated as an ordinary first statement, not a
    // directive, so the following statements are counted normally. (Any real
    // function/script-body directive is already demoted by the entry-counter /
    // preamble the plugin prepends, so this splits nothing meaningful.)
    #[test]
    fn stmt_block_directive_not_special_cased_in_generic_lists() {
        // Nested bare block: "x" is the first statement (no counter before it),
        // foo() and bar() each get an inter-statement counter.
        let out = transform_trace_stmt_blocks(r#"{ "x"; foo(); bar(); }"#);
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            2,
            "leading string in nested block wrongly treated as directive: {out}"
        );
    }

    // Hoisted function declarations stay at the head with no counter before
    // them; the first counter appears before the first executable call.
    #[test]
    fn stmt_block_hoisted_fn_decls_stay_first() {
        let out = transform_trace_stmt_blocks(r#"function f(){ function g(){} h(); k(); }"#);
        // f entry + g entry + 1 inter-statement counter (before k, not before h) = 3
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            3,
            "hoisted decl counted or first executable counted: {out}"
        );
    }

    // Insertion stops after a terminator: no counter before the unreachable
    // statement following a `return`.
    #[test]
    fn stmt_block_stops_after_terminator() {
        let out = transform_trace_stmt_blocks(r#"function f(){ a(); return x; b(); }"#);
        // f entry + counter before `return` (a() completed) = 2; none before b()
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            2,
            "counter emitted after terminator (dead code): {out}"
        );
    }

    // Disabled by default: no inter-statement counters without the flag.
    #[test]
    fn stmt_block_disabled_by_default() {
        let out = transform_no_trace_cmp(r#"function f(){ a(); b(); c(); }"#);
        // only the function entry counter
        assert_eq!(
            out.matches("__vitiate_cov[").count(),
            1,
            "no inter-statement counters should be emitted by default: {out}"
        );
    }

    /// Extract the numeric indices from every `__vitiate_cov[N]` counter in the
    /// emitted output (ignores the `var __vitiate_cov = ...` preamble, which has
    /// no `[`).
    fn cov_indices(out: &str) -> Vec<u32> {
        const NEEDLE: &str = "__vitiate_cov[";
        out.match_indices(NEEDLE)
            .filter_map(|(i, _)| {
                let rest = &out[i + NEEDLE.len()..];
                let end = rest.find(']')?;
                rest[..end].parse::<u32>().ok()
            })
            .collect()
    }

    // Regression for the after-children span-capture bug: a short-circuit /
    // ternary arm whose value is rewritten during descent (comparison -> CmpLog
    // IIFE, or call -> (counter, call) sequence, both DUMMY_SP) must still get a
    // counter keyed on the arm's ORIGINAL span, not id(file, 0, 0).
    #[test]
    fn short_circuit_arms_do_not_alias_after_child_rewrite() {
        // Comparison-valued ternary arms (default mode) get distinct ids.
        let out = transform_default(r#"var z = f ? a === b : c === d;"#);
        let ids = cov_indices(&out);
        assert_eq!(ids.len(), 2, "expected two ternary arm counters: {out}");
        assert_ne!(ids[0], ids[1], "ternary arm counters alias: {out}");

        // Comparison-valued logical RHS across two statements must not both
        // collapse to id(file, 0, 0).
        let out2 = transform_default(r#"var z = p && a === b; var w = q && c === d;"#);
        let ids2 = cov_indices(&out2);
        assert_eq!(ids2.len(), 2, "expected two logical-RHS counters: {out2}");
        assert_ne!(ids2[0], ids2[1], "logical-RHS counters alias: {out2}");

        // Call-valued ternary arms (+call): the two arm (Block) counters and the
        // two call (Call) counters are all distinct.
        let out3 = transform_trace_calls(r#"var z = f ? g() : h();"#);
        let mut ids3 = cov_indices(&out3);
        assert_eq!(ids3.len(), 4, "expected 2 arm + 2 call counters: {out3}");
        ids3.sort_unstable();
        ids3.dedup();
        assert_eq!(ids3.len(), 4, "call-ternary counters alias: {out3}");
    }

    // Distinct edge kinds at a shared span do not alias: Block, Call, and
    // StmtBlock ids for the same span differ.
    #[test]
    fn edge_kinds_distinct_at_shared_span() {
        let v = TransformVisitor::default_for_test();
        let span = Span {
            lo: swc_core::common::BytePos(10),
            hi: swc_core::common::BytePos(20),
        };
        let block = v.edge_id(span, EdgeKind::Block);
        let call = v.edge_id(span, EdgeKind::Call);
        let stmt = v.edge_id(span, EdgeKind::StmtBlock);
        assert_ne!(block, call, "Block and Call alias");
        assert_ne!(block, stmt, "Block and StmtBlock alias");
        assert_ne!(call, stmt, "Call and StmtBlock alias");
    }

    // With both flags off, output is byte-identical to the pre-change default
    // transform for a call- and statement-heavy fixture (no drift for existing
    // users). Guarded by comparing the default visitor against an explicitly
    // all-off config.
    #[test]
    fn flags_off_matches_default_transform() {
        let src = r#"function f(x){ var y = g(x); h(y); if (y) { k(); } return y; }"#;
        let default_out = transform_default(src);
        let explicit_off = PluginConfig {
            trace_calls: false,
            trace_stmt_blocks: false,
            ..PluginConfig::default()
        };
        let off_out = transform(
            src,
            &mut TransformVisitor::new(explicit_off, "test.js".to_string()),
        );
        assert_eq!(default_out, off_out, "flags-off drifted from default");
    }
}
