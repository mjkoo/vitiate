import { fuzz } from "@vitiate/core";
import forge from "node-forge";

// node-forge (pinned 1.3.1): drive the recursive ASN.1/DER decoder and the
// X.509 / PKCS re-walk decoders so the deep decode graph
// (asn1 -> oids -> pki/pkcs7) is exercised. node-forge is pure CommonJS, so the
// coverage measured here comes entirely from vitiate's `instrument.packages`
// CJS instrumentation. Malformed-input errors are expected and swallowed; the
// oracle only asserts that a *successful* decode produced a well-formed object.
fuzz("node-forge asn1/der + x509/pkcs decode", (data: Buffer) => {
  let asn1;
  try {
    asn1 = forge.asn1.fromDer(forge.util.createBuffer(data.toString("binary")));
  } catch {
    // Most inputs are not valid DER; that is expected.
    return;
  }

  if (asn1 === null || typeof asn1 !== "object") {
    throw new Error(
      "asn1.fromDer returned a non-object for a successful parse",
    );
  }

  // Push the decoded tree into the higher decoders. These throw on
  // structurally-invalid certificates/keys, which is expected - we only need
  // the code paths to execute for coverage.
  try {
    forge.pki.certificateFromAsn1(asn1);
  } catch {
    /* expected */
  }
  try {
    forge.pki.publicKeyFromAsn1(asn1);
  } catch {
    /* expected */
  }
  try {
    forge.pki.privateKeyFromAsn1(asn1);
  } catch {
    /* expected */
  }
  try {
    forge.pkcs7.messageFromAsn1(asn1);
  } catch {
    /* expected */
  }
});
