'use strict';

const OPEN_TAGS = ['think', 'thinking', 'analysis', 'reasoning'];
const MAX_PROBE_CHARS = 64 * 1024;

class VisibleAnswerFilter {
  constructor() {
    this.state = 'probing';
    this.buffer = '';
    this.closeTag = '';
    this.removedHiddenBlock = false;
  }

  push(text) {
    if (!text) return '';
    let input = text;
    let output = '';

    while (input) {
      if (this.state === 'visible') return output + input;

      if (this.state === 'probing') {
        this.buffer += input;
        input = '';
        const leadingWhitespace = this.buffer.match(/^\s*/)[0].length;
        const candidate = this.buffer.slice(leadingWhitespace);
        if (!candidate) {
          if (this.removedHiddenBlock) {
            this.buffer = '';
            return output;
          }
          if (this.buffer.length > MAX_PROBE_CHARS) {
            const releasedLength = this.buffer.length - MAX_PROBE_CHARS;
            output += this.buffer.slice(0, releasedLength);
            this.buffer = this.buffer.slice(releasedLength);
          }
          return output;
        }

        const opening = candidate.match(/^<(think|thinking|analysis|reasoning)>/i);
        if (opening) {
          this.state = 'hidden';
          this.closeTag = `</${opening[1]}>`;
          input = candidate.slice(opening[0].length);
          this.buffer = '';
          continue;
        }

        const lowerCandidate = candidate.toLowerCase();
        const couldBeOpening = OPEN_TAGS.some(tag => `<${tag}>`.startsWith(lowerCandidate));
        if (couldBeOpening) {
          if (this.removedHiddenBlock) {
            this.buffer = candidate;
          } else if (leadingWhitespace > MAX_PROBE_CHARS) {
            const releasedLength = leadingWhitespace - MAX_PROBE_CHARS;
            output += this.buffer.slice(0, releasedLength);
            this.buffer = this.buffer.slice(releasedLength);
          }
          return output;
        }

        this.state = 'visible';
        output += this.removedHiddenBlock ? candidate : this.buffer;
        this.buffer = '';
        return output;
      }

      const combined = this.buffer + input;
      const closeIndex = combined.toLowerCase().indexOf(this.closeTag.toLowerCase());
      if (closeIndex === -1) {
        this.buffer = combined.slice(-(this.closeTag.length - 1));
        return output;
      }

      input = combined.slice(closeIndex + this.closeTag.length);
      this.buffer = '';
      this.closeTag = '';
      this.removedHiddenBlock = true;
      this.state = 'probing';
    }

    return output;
  }

  finish() {
    if (this.state === 'hidden') {
      this.buffer = '';
      this.state = 'visible';
      return '';
    }
    if (this.state !== 'probing') return '';

    const output = this.removedHiddenBlock ? this.buffer.replace(/^\s*/, '') : this.buffer;
    this.buffer = '';
    this.state = 'visible';
    return output;
  }
}

module.exports = VisibleAnswerFilter;
