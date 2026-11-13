// The microphone's sound, gathered into pieces for a page (media.ts). It runs where the browser
// makes sound, apart from the site, and is given the microphone's samples a few at a time, of one
// channel. It hands the site a piece each time it has gathered as many samples as it was told one
// piece holds, and keeps none of them.
class SoundPieces extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const samples = Number(options?.processorOptions?.samples)
    this.size = Number.isInteger(samples) && samples > 0 && samples <= 4096 ? samples : 960
    this.piece = new Float32Array(this.size)
    this.gathered = 0
  }

  process(inputs) {
    const heard = inputs[0]?.[0]
    if (!heard) return true
    for (let at = 0; at < heard.length; at++) {
      this.piece[this.gathered++] = heard[at]
      if (this.gathered < this.size) continue
      // Handed over whole, and not copied: the next piece is gathered into a new one
      this.port.postMessage(this.piece, [this.piece.buffer])
      this.piece = new Float32Array(this.size)
      this.gathered = 0
    }
    return true
  }
}
registerProcessor('it-sound-pieces', SoundPieces)
