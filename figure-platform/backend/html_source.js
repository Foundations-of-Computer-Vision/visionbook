function decodeEscapedHtmlSource(source) {
  if (typeof source !== 'string') {
    throw new TypeError('HTML source must be a string.');
  }

  try {
    return JSON.parse(`"${source.replace(/"/g, '\\"').replace(/\r\n/g, '\\n').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`);
  } catch {
    return source
      .replace(/\\r\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
  }
}

function looksEscapedHtmlSource(source) {
  return /\\r\\n|\\n|\\t|\\"|\\'/.test(source);
}

function normalizeHtmlSource(source) {
  if (typeof source !== 'string') {
    throw new TypeError('HTML source must be a string.');
  }

  const trimmed = source.trimStart();
  if (!looksEscapedHtmlSource(source) && (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<'))) {
    return source;
  }

  const decoded = decodeEscapedHtmlSource(source);
  const trimmed = decoded.trimStart();
  return trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<')
    ? decoded
    : source;
}

module.exports = {
  decodeEscapedHtmlSource,
  normalizeHtmlSource,
};