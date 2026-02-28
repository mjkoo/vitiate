/**
 * A simple parser with a planted bug for end-to-end fuzz testing.
 */
export function parseCommand(data: Buffer): string {
  if (data.length < 1) return "empty";

  const cmd = String.fromCharCode(data[0]!);

  if (cmd === "G") {
    if (data.length >= 4) {
      const sub = data.subarray(1, 4).toString();
      if (sub === "ET!") {
        // Planted bug: crashes on input "GET!"
        throw new Error("parser crash: unexpected command terminator");
      }
    }
    return "get";
  }

  if (cmd === "S") {
    return "set";
  }

  return "unknown";
}
