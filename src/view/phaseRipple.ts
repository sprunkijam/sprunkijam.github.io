import { Filter, GlProgram, UniformGroup } from "pixi.js";

/**
 * Overlay filter for phase hops: radial shockwave + a cheap 5-tap bloom.
 * GLSL ES 3.0 for WebGL. Applied only to the cinematic overlay — never the
 * whole jam stage.
 */

const GL_VERTEX = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}
`;

const GL_FRAGMENT = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uAmount;
uniform float uCenterX;
uniform float uCenterY;

void main() {
  vec2 uv = vTextureCoord;
  vec2 center = vec2(uCenterX, uCenterY);
  vec2 delta = uv - center;
  float r = length(delta);
  vec2 dir = r > 0.0001 ? delta / r : vec2(0.0);
  float ring = sin(r * 26.0 - uTime * 7.2) * 0.016 * uAmount;
  float fall = smoothstep(0.62, 0.05, r);
  vec2 warp = dir * ring * fall;
  vec2 sampleUv = uv + warp;

  vec4 color = texture(uTexture, sampleUv);
  vec2 px = vec2(0.0036, 0.0036) * (0.4 + uAmount * 0.8);
  vec4 bloom =
    texture(uTexture, sampleUv + vec2(px.x, 0.0)) +
    texture(uTexture, sampleUv - vec2(px.x, 0.0)) +
    texture(uTexture, sampleUv + vec2(0.0, px.y)) +
    texture(uTexture, sampleUv - vec2(0.0, px.y));
  color = mix(color, bloom * 0.25, 0.32 + uAmount * 0.28);

  float ca = 0.0032 * uAmount;
  float cr = texture(uTexture, sampleUv + dir * ca).r;
  float cb = texture(uTexture, sampleUv - dir * ca).b;
  finalColor = vec4(cr, color.g, cb, color.a);
}
`;

export class PhaseRippleFilter extends Filter {
  private readonly rippleUniforms: UniformGroup<{
    uTime: { value: number; type: "f32" };
    uAmount: { value: number; type: "f32" };
    uCenterX: { value: number; type: "f32" };
    uCenterY: { value: number; type: "f32" };
  }>;

  constructor(resolution: number) {
    const rippleUniforms = new UniformGroup({
      uTime: { value: 0, type: "f32" },
      uAmount: { value: 0, type: "f32" },
      uCenterX: { value: 0.5, type: "f32" },
      uCenterY: { value: 0.32, type: "f32" },
    });
    const glProgram = GlProgram.from({
      vertex: GL_VERTEX,
      fragment: GL_FRAGMENT,
      name: "phase-ripple-filter",
    });
    super({
      glProgram,
      resources: { rippleUniforms },
      resolution,
      padding: 12,
      antialias: "off",
    });
    this.rippleUniforms = rippleUniforms;
  }

  setPulse(time: number, amount: number, cx: number, cy: number): void {
    const u = this.rippleUniforms.uniforms;
    u.uTime = time;
    u.uAmount = amount;
    u.uCenterX = cx;
    u.uCenterY = cy;
  }
}
