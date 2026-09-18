const glyphs = ['01111/11000/11000/11000/11000/11000/01111', '01111/11000/11000/11000/11000/11000/01111', '11111/11000/11000/11110/11000/11000/11000'];

// Integer-aligned vector pixels stay sharp at both navigation and login sizes.
export function brandMarkup() {
  const pixels = glyphs.map((glyph, letter) => `<g class="brand-letter-${letter}">${glyph.split('/').map((row, y) => [...row].map((pixel, x) => pixel === '1' ? `<rect x="${x + letter * 7}" y="${y}" width="1" height="1"/>` : '').join('')).join('')}</g>`).join('');
  return `<span class="pixel-brand" role="img" aria-label="CCF"><svg class="pixel-brand-letters" viewBox="0 0 19 7" aria-hidden="true" shape-rendering="crispEdges">${pixels}</svg><span class="pixel-brand-cursor" aria-hidden="true"></span></span>`;
}
