/**
 * Which frames of a capture that repeats an unchanged picture are worth encoding. A system capturer (ScreenCaptureKit,
 * Windows Graphics Capture, PipeWire) keeps sending a still window at its rate, about 29 frames a second, and each
 * would cost an encode and a unit. The gate compares a small copy of each frame with the last: a frame that changed
 * passes, then `settle` more of the same picture (a hardware encoder sharpens a still picture over a few frames), then
 * nothing until it changes, apart from one a second while it doesn't, in case a change too small for the copy to show
 * (a caret, one character) was missed.
 */
export class ChangeGate<Frame = VideoFrame> {
  readonly #sample: (frame: Frame) => Uint8Array | undefined
  readonly #settle: number
  readonly #refreshMs: number
  readonly #now: () => number
  #previous?: Uint8Array
  #settling = 0
  #passedAt = -Infinity

  constructor(sample: (frame: Frame) => Uint8Array | undefined, settle = 2, refreshMs = 1000, now: () => number = () => performance.now()) {
    this.#sample = sample
    this.#settle = settle
    this.#refreshMs = refreshMs
    this.#now = now
  }

  /** Whether to encode `frame`. A frame that can't be sampled passes. */
  admit(frame: Frame): boolean {
    const sample = this.#sample(frame)
    const now = this.#now()
    if (!sample) return this.#pass(now)
    const previous = this.#previous
    this.#previous = sample
    if (!previous || !sameBytes(previous, sample)) {
      this.#settling = this.#settle
      return this.#pass(now)
    }
    if (this.#settling > 0) {
      this.#settling--
      return this.#pass(now)
    }
    return now - this.#passedAt >= this.#refreshMs ? this.#pass(now) : false
  }

  #pass(now: number): true {
    this.#passedAt = now
    return true
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false
  return true
}

const VERTEX = `#version 300 es
in vec2 corner;
out vec2 at;
void main() {
  at = vec2(corner.x, 1.0 - corner.y) * 0.5 + 0.5;
  gl_Position = vec4(corner, 0.0, 1.0);
}`
const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D picture;
in vec2 at;
out vec4 color;
void main() { color = texture(picture, at); }`

/**
 * A frame's `width`×`height` copy, made on the GPU: the frame is uploaded as a texture, averaged down through its
 * mipmaps, and only the copy is read back, never the whole picture. None where WebGL 2 isn't there.
 */
export function gpuSampler(width = 160, height = 100): ((frame: VideoFrame) => Uint8Array | undefined) | undefined {
  const canvas = new OffscreenCanvas(width, height)
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false })
  if (!gl) return undefined
  const program = gl.createProgram()
  const vertex = gl.createShader(gl.VERTEX_SHADER)
  const fragment = gl.createShader(gl.FRAGMENT_SHADER)
  if (!vertex || !fragment) return undefined
  gl.shaderSource(vertex, VERTEX)
  gl.shaderSource(fragment, FRAGMENT)
  gl.compileShader(vertex)
  gl.compileShader(fragment)
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return undefined
  gl.useProgram(program)
  const corners = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, corners)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const corner = gl.getAttribLocation(program, "corner")
  gl.enableVertexAttribArray(corner)
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.viewport(0, 0, width, height)
  return (frame) => {
    if (gl.isContextLost()) return undefined
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
    if (gl.getError() !== gl.NO_ERROR) return undefined
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    const pixels = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return pixels
  }
}
