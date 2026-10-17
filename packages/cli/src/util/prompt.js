// Read a secret from the terminal without echoing it, or from stdin when piped.

/**
 * @param {string} question
 * @param {{ stdin?: boolean }} [o]
 * @returns {Promise<string>}
 */
export async function readSecret(question, o = {}) {
  if (o.stdin || !process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (/** @type {string} */ ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          done();
          resolve(value.trim());
          return;
        }
        if (c === '\u0003') {
          done();
          reject(new Error('Cancelled'));
          return;
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    stdin.on('data', onData);
  });
}
