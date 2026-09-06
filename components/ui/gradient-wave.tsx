'use client'

/*
 * WebGL animated mesh gradient — the "whatamesh"/Stripe-style backdrop.
 *
 * Adapted from a third-party drop-in. The renderer (MiniGl + Gradient) is kept
 * close to the original, but five defects in the source were fixed, each marked
 * FIX below. They are not stylistic: three of them break this component outright
 * in a screen that re-renders on every keystroke, which is exactly where it is
 * used here (the onboarding ask box).
 *
 * Consumers should not import this directly — go through
 * components/backdrop/WeatherAurora.tsx, which owns the palettes and the
 * reduced-motion / no-WebGL fallback.
 */

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * Hard ceiling on colours, and the reason for it.
 *
 * Each colour after the first becomes a wave layer, and the vertex shader gates
 * each layer on `u_active_colors[i + 1]`. `u_active_colors` is a vec4, so the
 * largest index it can address is 3 — which means at most 3 wave layers, which
 * means at most 4 colours. The upstream default passed 6, silently indexing a
 * vec4 out of range: on a permissive driver the last two layers read garbage, on
 * a strict one the shader fails to compile and the try/catch below turns the
 * whole backdrop into an empty div. Clamped rather than widened, because 4
 * colours is what the effect was designed around.
 */
const MAX_COLORS = 4

function normalizeColor(hexCode: number): number[] {
  return [
    ((hexCode >> 16) & 255) / 255,
    ((hexCode >> 8) & 255) / 255,
    (255 & hexCode) / 255,
  ]
}

class MiniGl {
  canvas: HTMLCanvasElement
  gl: WebGLRenderingContext
  meshes: any[] = []
  commonUniforms: any
  width?: number
  height?: number
  Material: any
  Uniform: any
  PlaneGeometry: any
  Mesh: any
  Attribute: any

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = this.canvas.getContext('webgl', { antialias: true })
    if (!gl) throw new Error('WebGL not supported')
    this.gl = gl

    const context = this.gl
    const _miniGl = this

    this.Uniform = class {
      type: string = 'float'
      value: any
      typeFn: string
      excludeFrom?: string
      transpose?: boolean

      constructor(e: any) {
        Object.assign(this, e)
        const typeMap: Record<string, string> = {
          float: '1f',
          int: '1i',
          vec2: '2fv',
          vec3: '3fv',
          vec4: '4fv',
          mat4: 'Matrix4fv',
        }
        this.typeFn = typeMap[this.type] || '1f'
      }

      update(location: any): void {
        if (this.value === undefined || location === null) return

        const isMatrix = this.typeFn.indexOf('Matrix') === 0
        const fn = `uniform${this.typeFn}`

        if (isMatrix) {
          ;(context as any)[fn](location, this.transpose || false, this.value)
        } else {
          ;(context as any)[fn](location, this.value)
        }
      }

      getDeclaration(name: string, type: string, length?: number): string {
        if (this.excludeFrom === type) return ''

        if (this.type === 'array') {
          return (
            this.value[0].getDeclaration(name, type, this.value.length) +
            `
const int ${name}_length = ${this.value.length};`
          )
        }

        if (this.type === 'struct') {
          let nameNoPrefix = name.replace('u_', '')
          nameNoPrefix = nameNoPrefix.charAt(0).toUpperCase() + nameNoPrefix.slice(1)
          const fields = Object.entries(this.value)
            .map(([n, u]: [string, any]) => u.getDeclaration(n, type).replace(/^uniform/, ''))
            .join('')
          return `uniform struct ${nameNoPrefix}
{
${fields}
} ${name}${length ? `[${length}]` : ''};`
        }

        return `uniform ${this.type} ${name}${length ? `[${length}]` : ''};`
      }
    }

    this.Attribute = class {
      type: number = context.FLOAT
      normalized: boolean = false
      buffer: WebGLBuffer
      target!: number
      size!: number
      values?: Float32Array | Uint16Array

      constructor(e: any) {
        this.buffer = context.createBuffer()!
        Object.assign(this, e)
      }

      update(): void {
        if (this.values) {
          context.bindBuffer(this.target, this.buffer)
          context.bufferData(this.target, this.values, context.STATIC_DRAW)
        }
      }

      attach(e: string, t: WebGLProgram): number {
        const n = context.getAttribLocation(t, e)
        if (this.target === context.ARRAY_BUFFER) {
          context.bindBuffer(this.target, this.buffer)
          context.enableVertexAttribArray(n)
          context.vertexAttribPointer(n, this.size, this.type, this.normalized, 0, 0)
        }
        return n
      }

      use(e: number): void {
        context.bindBuffer(this.target, this.buffer)
        if (this.target === context.ARRAY_BUFFER) {
          context.enableVertexAttribArray(e)
          context.vertexAttribPointer(e, this.size, this.type, this.normalized, 0, 0)
        }
      }
    }

    this.Material = class {
      uniforms: any
      uniformInstances: any[] = []
      program!: WebGLProgram

      constructor(vertexShaders: string, fragments: string, uniforms: any = {}) {
        const material = this

        function getShader(type: number, source: string): WebGLShader {
          const shader = context.createShader(type)!
          context.shaderSource(shader, source)
          context.compileShader(shader)
          if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
            console.error(context.getShaderInfoLog(shader))
            throw new Error('Shader compilation error')
          }
          return shader
        }

        function getUniformDeclarations(uniforms: any, type: string): string {
          return Object.entries(uniforms)
            .map(([uniform, value]: [string, any]) => value.getDeclaration(uniform, type))
            .join('\n')
        }

        material.uniforms = uniforms
        const prefix = 'precision highp float;'

        const vertexSource = `
          ${prefix}
          attribute vec4 position;
          attribute vec2 uv;
          attribute vec2 uvNorm;
          ${getUniformDeclarations(_miniGl.commonUniforms, 'vertex')}
          ${getUniformDeclarations(uniforms, 'vertex')}
          ${vertexShaders}
        `

        const fragmentSource = `
          ${prefix}
          ${getUniformDeclarations(_miniGl.commonUniforms, 'fragment')}
          ${getUniformDeclarations(uniforms, 'fragment')}
          ${fragments}
        `

        material.program = context.createProgram()!
        context.attachShader(material.program, getShader(context.VERTEX_SHADER, vertexSource))
        context.attachShader(material.program, getShader(context.FRAGMENT_SHADER, fragmentSource))
        context.linkProgram(material.program)

        if (!context.getProgramParameter(material.program, context.LINK_STATUS)) {
          console.error(context.getProgramInfoLog(material.program))
          throw new Error('Program linking error')
        }

        context.useProgram(material.program)
        material.attachUniforms(undefined, _miniGl.commonUniforms)
        material.attachUniforms(undefined, material.uniforms)
      }

      attachUniforms(name: string | undefined, uniforms: any): void {
        if (name === undefined) {
          Object.entries(uniforms).forEach(([n, u]) => this.attachUniforms(n, u))
        } else if (uniforms.type === 'array') {
          uniforms.value.forEach((u: any, i: number) => this.attachUniforms(`${name}[${i}]`, u))
        } else if (uniforms.type === 'struct') {
          Object.entries(uniforms.value).forEach(([u, i]) => this.attachUniforms(`${name}.${u}`, i))
        } else {
          this.uniformInstances.push({
            uniform: uniforms,
            location: context.getUniformLocation(this.program, name),
          })
        }
      }
    }

    this.PlaneGeometry = class {
      width: number = 1
      height: number = 1
      attributes: any
      vertexCount: number = 0
      xSegCount: number = 0
      ySegCount: number = 0

      constructor() {
        this.attributes = {
          position: new _miniGl.Attribute({ target: context.ARRAY_BUFFER, size: 3 }),
          uv: new _miniGl.Attribute({ target: context.ARRAY_BUFFER, size: 2 }),
          uvNorm: new _miniGl.Attribute({ target: context.ARRAY_BUFFER, size: 2 }),
          index: new _miniGl.Attribute({
            target: context.ELEMENT_ARRAY_BUFFER,
            size: 3,
            type: context.UNSIGNED_SHORT,
          }),
        }
      }

      setTopology(xSegs = 1, ySegs = 1): void {
        this.xSegCount = xSegs
        this.ySegCount = ySegs
        this.vertexCount = (this.xSegCount + 1) * (this.ySegCount + 1)
        const quadCount = this.xSegCount * this.ySegCount * 2

        this.attributes.uv.values = new Float32Array(2 * this.vertexCount)
        this.attributes.uvNorm.values = new Float32Array(2 * this.vertexCount)
        this.attributes.index.values = new Uint16Array(3 * quadCount)

        for (let y = 0; y <= this.ySegCount; y++) {
          for (let x = 0; x <= this.xSegCount; x++) {
            const i = y * (this.xSegCount + 1) + x
            this.attributes.uv.values[2 * i] = x / this.xSegCount
            this.attributes.uv.values[2 * i + 1] = 1 - y / this.ySegCount
            this.attributes.uvNorm.values[2 * i] = (x / this.xSegCount) * 2 - 1
            this.attributes.uvNorm.values[2 * i + 1] = 1 - (y / this.ySegCount) * 2

            if (x < this.xSegCount && y < this.ySegCount) {
              const s = y * this.xSegCount + x
              this.attributes.index.values[6 * s] = i
              this.attributes.index.values[6 * s + 1] = i + 1 + this.xSegCount
              this.attributes.index.values[6 * s + 2] = i + 1
              this.attributes.index.values[6 * s + 3] = i + 1
              this.attributes.index.values[6 * s + 4] = i + 1 + this.xSegCount
              this.attributes.index.values[6 * s + 5] = i + 2 + this.xSegCount
            }
          }
        }

        this.attributes.uv.update()
        this.attributes.uvNorm.update()
        this.attributes.index.update()
      }

      setSize(width = 1, height = 1): void {
        this.width = width
        this.height = height
        this.attributes.position.values = new Float32Array(3 * this.vertexCount)

        const offsetX = width / -2
        const offsetY = height / -2
        const segWidth = width / this.xSegCount
        const segHeight = height / this.ySegCount

        for (let y = 0; y <= this.ySegCount; y++) {
          const posY = offsetY + y * segHeight
          for (let x = 0; x <= this.xSegCount; x++) {
            const posX = offsetX + x * segWidth
            const idx = y * (this.xSegCount + 1) + x
            this.attributes.position.values[3 * idx] = posX
            this.attributes.position.values[3 * idx + 1] = -posY
            this.attributes.position.values[3 * idx + 2] = 0
          }
        }

        this.attributes.position.update()
      }
    }

    this.Mesh = class {
      geometry: any
      material: any
      attributeInstances: any[] = []

      constructor(geometry: any, material: any) {
        this.geometry = geometry
        this.material = material

        Object.entries(this.geometry.attributes).forEach(([e, attribute]: [string, any]) => {
          this.attributeInstances.push({
            attribute: attribute,
            location: attribute.attach(e, this.material.program),
          })
        })

        _miniGl.meshes.push(this)
      }

      draw(): void {
        context.useProgram(this.material.program)
        this.material.uniformInstances.forEach(({ uniform, location }: any) =>
          uniform.update(location)
        )
        this.attributeInstances.forEach(({ attribute, location }: any) =>
          attribute.use(location)
        )
        context.drawElements(
          context.TRIANGLES,
          this.geometry.attributes.index.values.length,
          context.UNSIGNED_SHORT,
          0
        )
      }
    }

    const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    this.commonUniforms = {
      projectionMatrix: new this.Uniform({ type: 'mat4', value: identityMatrix }),
      modelViewMatrix: new this.Uniform({ type: 'mat4', value: identityMatrix }),
      resolution: new this.Uniform({ type: 'vec2', value: [1, 1] }),
      aspectRatio: new this.Uniform({ type: 'float', value: 1 }),
    }
  }

  setSize(w = 640, h = 480): void {
    this.width = w
    this.height = h
    this.canvas.width = w
    this.canvas.height = h
    this.gl.viewport(0, 0, w, h)
    this.commonUniforms.resolution.value = [w, h]
    this.commonUniforms.aspectRatio.value = w / h
  }

  setOrthographicCamera(): void {
    this.commonUniforms.projectionMatrix.value = [
      2 / this.width!, 0, 0, 0,
      0, 2 / this.height!, 0, 0,
      0, 0, -0.001, 0,
      0, 0, 0, 1,
    ]
  }

  render(): void {
    this.gl.clearColor(0, 0, 0, 0)
    this.gl.clearDepth(1)
    this.meshes.forEach((m) => m.draw())
  }
}

class Gradient {
  canvas: HTMLCanvasElement
  colors: string[]
  minigl: MiniGl
  mesh: any
  time = 0
  last = 0
  animationId?: number
  isPlaying = false
  /** Desired top-darkening strength, so resize() can't overwrite it (see FIX 4). */
  shadowPower = 5
  private observer?: ResizeObserver

  constructor(canvas: HTMLCanvasElement, colors: string[]) {
    this.canvas = canvas
    // FIX 1: clamp to what the shader's vec4 gate can actually address.
    this.colors = colors.slice(0, MAX_COLORS)
    this.minigl = new MiniGl(canvas)
    this.init()
  }

  init(): void {
    const sectionColors = this.colors.map((hex) =>
      normalizeColor(parseInt(hex.replace('#', '0x'), 16))
    )

    const uniforms = {
      u_time: new this.minigl.Uniform({ value: 0 }),
      u_shadow_power: new this.minigl.Uniform({ value: 5 }),
      u_darken_top: new this.minigl.Uniform({ value: 0 }),
      u_active_colors: new this.minigl.Uniform({ value: [1, 1, 1, 1], type: 'vec4' }),
      u_global: new this.minigl.Uniform({
        value: {
          noiseFreq: new this.minigl.Uniform({ value: [0.00014, 0.00029], type: 'vec2' }),
          noiseSpeed: new this.minigl.Uniform({ value: 0.000005 }),
        },
        type: 'struct',
      }),
      u_vertDeform: new this.minigl.Uniform({
        value: {
          incline: new this.minigl.Uniform({ value: 0 }),
          offsetTop: new this.minigl.Uniform({ value: -0.5 }),
          offsetBottom: new this.minigl.Uniform({ value: -0.5 }),
          noiseFreq: new this.minigl.Uniform({ value: [3, 4], type: 'vec2' }),
          noiseAmp: new this.minigl.Uniform({ value: 320 }),
          noiseSpeed: new this.minigl.Uniform({ value: 10 }),
          noiseFlow: new this.minigl.Uniform({ value: 3 }),
          noiseSeed: new this.minigl.Uniform({ value: 5 }),
        },
        type: 'struct',
        excludeFrom: 'fragment',
      }),
      u_baseColor: new this.minigl.Uniform({
        value: sectionColors[0],
        type: 'vec3',
        excludeFrom: 'fragment',
      }),
      u_waveLayers: new this.minigl.Uniform({
        value: [],
        excludeFrom: 'fragment',
        type: 'array',
      }),
    }

    for (let i = 1; i < sectionColors.length; i++) {
      uniforms.u_waveLayers.value.push(
        new this.minigl.Uniform({
          value: {
            color: new this.minigl.Uniform({ value: sectionColors[i], type: 'vec3' }),
            noiseFreq: new this.minigl.Uniform({
              value: [2 + i / sectionColors.length, 3 + i / sectionColors.length],
              type: 'vec2',
            }),
            noiseSpeed: new this.minigl.Uniform({ value: 11 + 0.3 * i }),
            noiseFlow: new this.minigl.Uniform({ value: 6.5 + 0.3 * i }),
            noiseSeed: new this.minigl.Uniform({ value: 5 + 10 * i }),
            noiseFloor: new this.minigl.Uniform({ value: 0.1 }),
            noiseCeil: new this.minigl.Uniform({ value: 0.63 + 0.07 * i }),
          },
          type: 'struct',
        })
      )
    }

    const vertexShader = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

vec3 blendNormal(vec3 base, vec3 blend) { return blend; }
vec3 blendNormal(vec3 base, vec3 blend, float opacity) { return (blend * opacity + base * (1.0 - opacity)); }

varying vec3 v_color;

void main() {
  float time = u_time * u_global.noiseSpeed;
  vec2 noiseCoord = resolution * uvNorm * u_global.noiseFreq;
  float tilt = resolution.y / 2.0 * uvNorm.y;
  float incline = resolution.x * uvNorm.x / 2.0 * u_vertDeform.incline;
  float offset = resolution.x / 2.0 * u_vertDeform.incline * mix(u_vertDeform.offsetBottom, u_vertDeform.offsetTop, uv.y);

  float noise = snoise(vec3(
    noiseCoord.x * u_vertDeform.noiseFreq.x + time * u_vertDeform.noiseFlow,
    noiseCoord.y * u_vertDeform.noiseFreq.y,
    time * u_vertDeform.noiseSpeed + u_vertDeform.noiseSeed
  )) * u_vertDeform.noiseAmp;

  noise *= 1.0 - pow(abs(uvNorm.y), 2.0);
  noise = max(0.0, noise);

  vec3 pos = vec3(position.x, position.y + tilt + incline + noise - offset, position.z);

  v_color = u_baseColor;

  for (int i = 0; i < u_waveLayers_length; i++) {
    if (u_active_colors[i + 1] == 1.) {
      WaveLayers layer = u_waveLayers[i];
      float layerNoise = smoothstep(
        layer.noiseFloor,
        layer.noiseCeil,
        snoise(vec3(
          noiseCoord.x * layer.noiseFreq.x + time * layer.noiseFlow,
          noiseCoord.y * layer.noiseFreq.y,
          time * layer.noiseSpeed + layer.noiseSeed
        )) / 2.0 + 0.5
      );
      v_color = blendNormal(v_color, layer.color, pow(layerNoise, 4.));
    }
  }

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}`

    const fragmentShader = `
varying vec3 v_color;

void main() {
  vec3 color = v_color;
  if (u_darken_top == 1.0) {
    vec2 st = gl_FragCoord.xy/resolution.xy;
    color.g -= pow(st.y + sin(-12.0) * st.x, u_shadow_power) * 0.4;
  }
  gl_FragColor = vec4(color, 1.0);
}`

    const material = new this.minigl.Material(vertexShader, fragmentShader, uniforms)
    const geometry = new this.minigl.PlaneGeometry()
    this.mesh = new this.minigl.Mesh(geometry, material)

    this.resize()

    // FIX 2: the original attached an anonymous `window.addEventListener('resize',
    // () => this.resize())` that it had no way to remove — every mount leaked a
    // listener holding the canvas and its WebGL context alive, and those listeners
    // kept firing against detached canvases. A ResizeObserver on the container is
    // both removable and more correct: it also catches the container changing size
    // when the window doesn't (layout shifts, the dashboard band).
    const target = this.canvas.parentElement
    if (target && typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize())
      this.observer.observe(target)
    }
  }

  resize(): void {
    // FIX 3: the original sized the drawing buffer to `window.innerWidth/Height`
    // regardless of how big the canvas actually was, so the gradient came out
    // stretched in any container whose aspect ratio differed from the viewport's
    // — and always paid full-viewport rasterisation cost. Measure the container.
    const box = this.canvas.parentElement
    const width = Math.max(1, Math.round(box?.clientWidth || window.innerWidth))
    const height = Math.max(1, Math.round(box?.clientHeight || window.innerHeight))

    this.minigl.setSize(width, height)
    this.minigl.setOrthographicCamera()

    const xSegCount = Math.ceil(width * 0.02)
    const ySegCount = Math.ceil(height * 0.05)
    this.mesh.geometry.setTopology(xSegCount, ySegCount)
    this.mesh.geometry.setSize(width, height)
    // FIX 4: the original hardcoded `width < 600 ? 5 : 6` here, silently
    // discarding the shadowPower the caller had set as soon as anything resized.
    this.mesh.material.uniforms.u_shadow_power.value = this.shadowPower
  }

  animate = (timestamp: number): void => {
    if (!this.isPlaying) return

    this.time += Math.min(timestamp - this.last, 1000 / 15)
    this.last = timestamp
    this.mesh.material.uniforms.u_time.value = this.time
    this.minigl.render()

    this.animationId = requestAnimationFrame(this.animate)
  }

  start(): void {
    if (this.isPlaying) return
    this.isPlaying = true
    // Reset the clock reference so a restart doesn't jump the animation forward
    // by however long it was paused.
    this.last = performance.now()
    this.animationId = requestAnimationFrame(this.animate)
  }

  stop(): void {
    this.isPlaying = false
    if (this.animationId) cancelAnimationFrame(this.animationId)
  }

  /** Full teardown. `stop()` alone leaves the observer and the GL context alive. */
  destroy(): void {
    this.stop()
    this.observer?.disconnect()
    this.observer = undefined
    // Hand the context back immediately instead of waiting for GC. Browsers cap
    // live WebGL contexts (~16) and evict the oldest, so releasing eagerly is
    // what keeps repeated mounts from killing an earlier canvas.
    this.minigl.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

export interface GradientWaveProps {
  /** Base colour first, then up to 3 wave layers. Extra entries are ignored. */
  colors?: string[]
  isPlaying?: boolean
  className?: string
  /** Strength of the top darkening. Only has an effect when darkenTop is true. */
  shadowPower?: number
  darkenTop?: boolean
  noiseSpeed?: number
  noiseFrequency?: [number, number]
  deform?: {
    incline?: number
    offsetTop?: number
    offsetBottom?: number
    noiseFreq?: [number, number]
    noiseAmp?: number
    noiseSpeed?: number
    noiseFlow?: number
    noiseSeed?: number
  }
}

/*
 * FIX 5, part one: these defaults live at module scope.
 *
 * As inline default parameter values they were re-created on every single call
 * of the component, so the array/object identities in the effect's dependency
 * list changed on every render even when a caller passed nothing. Combined with
 * part two below, that tore down and rebuilt the whole WebGL context on each
 * render — and this component renders inside a screen with a controlled text
 * input, i.e. once per keystroke.
 */
const DEFAULT_COLORS = ['#7CC6FE', '#E8F4FF', '#A8D8FF', '#FFFFFF']
const DEFAULT_NOISE_FREQUENCY: [number, number] = [0.0001, 0.0009]
const DEFAULT_DEFORM = { incline: 0.5, noiseAmp: 250, noiseFlow: 5 }

export function GradientWave({
  colors = DEFAULT_COLORS,
  isPlaying = true,
  className,
  shadowPower = 8,
  darkenTop = false,
  noiseSpeed = 0.00001,
  noiseFrequency = DEFAULT_NOISE_FREQUENCY,
  deform = DEFAULT_DEFORM,
}: GradientWaveProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const gradientRef = useRef<Gradient | null>(null)

  // FIX 5, part two: serialise the object-valued props so the dependency list is
  // all primitives. Re-initialising is expensive and visibly restarts the
  // animation, so it must happen only when the values actually differ.
  const colorKey = colors.join(',')
  const freqKey = noiseFrequency.join(',')
  const deformKey = JSON.stringify(deform)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const canvas = document.createElement('canvas')
    Object.assign(canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      display: 'block',
    })
    container.appendChild(canvas)

    try {
      const gradient = new Gradient(canvas, colors)
      gradientRef.current = gradient

      gradient.shadowPower = shadowPower
      gradient.mesh.material.uniforms.u_shadow_power.value = shadowPower
      gradient.mesh.material.uniforms.u_darken_top.value = darkenTop ? 1 : 0
      gradient.mesh.material.uniforms.u_global.value.noiseFreq.value = noiseFrequency
      gradient.mesh.material.uniforms.u_global.value.noiseSpeed.value = noiseSpeed

      // FIX 6: the original spread `deform`'s raw numbers over a map of Uniform
      // instances, replacing the wrappers with primitives. That was a silent
      // no-op twice over — Material snapshots the Uniform objects at construction
      // and never re-reads this map, so the deform prop had no effect at all.
      // Mutating `.value` on the surviving wrappers is what actually reaches the
      // GPU, which is why the four assignments above did work.
      const vertDeform = gradient.mesh.material.uniforms.u_vertDeform.value
      for (const [key, value] of Object.entries(deform)) {
        if (vertDeform[key] && value !== undefined) vertDeform[key].value = value
      }

      if (isPlaying) gradient.start()
    } catch (error) {
      // No WebGL, or a shader the driver rejected. WeatherAurora always paints a
      // CSS gradient underneath, so the screen still looks right — it just
      // doesn't move.
      console.error('Failed to initialize gradient:', error)
    }

    return () => {
      gradientRef.current?.destroy()
      gradientRef.current = null
      canvas.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- object props are
    // tracked through the serialised keys above; see FIX 5.
  }, [colorKey, isPlaying, shadowPower, darkenTop, noiseSpeed, freqKey, deformKey])

  return (
    <div
      ref={containerRef}
      className={cn('absolute inset-0 z-0 h-full w-full overflow-hidden', className)}
    />
  )
}
