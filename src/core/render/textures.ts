import { Graphics, Rectangle, Text, Texture, type Renderer } from 'pixi.js';
import { hex, type Palette } from '../../ui/theme/tokens';

/**
 * Every shape the playfield draws, baked once into textures, so the frame loop
 * only moves sprites and everything batches. Rebuilt when the theme changes.
 *
 * Shapes are drawn centred on (0,0) at BASE px and rendered at 2× resolution;
 * sprites scale them to the layout's note size.
 */
export const BASE = 96;

export interface TextureBank {
  tap: [Texture, Texture];       // per lane
  big: [Texture, Texture];
  holdTail: [Texture, Texture];
  rollHead: Texture;
  mash: Texture;
  mine: Texture;
  collect: Texture;
  receptor: Texture;
  particle: Texture;
  spark: Texture;
  flash: Texture;                // horizontal gradient (lane press flash)
  glow: Texture;                 // radial glow
  judgement: Texture[];          // PERFECT GREAT GOOD MISS
  extra: Record<'big' | 'break' | 'mine' | 'clear', Texture>;
  white: Texture;
}

/** Chamfered rectangle (top-right and bottom-left cut), centred */
export const chamferPoly = (w: number, h: number, c: number): number[] => {
  const x = w / 2;
  const y = h / 2;
  return [-x, -y, x - c, -y, x, -y + c, x, y, -x + c, y, -x, y - c];
};

/** Fully cut octagon */
const octPoly = (s: number, c: number): number[] => {
  const x = s / 2;
  return [-x + c, -x, x - c, -x, x, -x + c, x, x - c, x - c, x, -x + c, x, -x, x - c, -x, -x + c];
};

/** HUD corner brackets on the square corners (top-left, bottom-right) */
const hudBrackets = (g: Graphics, w: number, h: number, len: number, color: number, width = 3, pad = 0) => {
  const x = w / 2 + pad;
  const y = h / 2 + pad;
  g.moveTo(-x, -y + len).lineTo(-x, -y).lineTo(-x + len, -y);
  g.moveTo(x, y - len).lineTo(x, y).lineTo(x - len, y);
  g.stroke({ width, color, cap: 'square', join: 'miter' });
};

const bake = (renderer: Renderer, g: Graphics | Text, size: number, resolution = 2): Texture => {
  const half = size / 2;
  const tex = renderer.generateTexture({ target: g, frame: new Rectangle(-half, -half, size, size), resolution, antialias: true });
  g.destroy();
  return tex;
};

const canvasTexture = (w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Texture => {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  return Texture.from(canvas);
};

export const buildTextures = (renderer: Renderer, p: Palette): TextureBank => {
  const bg = hex(p.bg);
  const text = hex(p.text);
  const lanes = [hex(p.laneUp), hex(p.laneDown)];
  const warn = hex(p.warning);
  const err = hex(p.error);
  const S = BASE;

  const tap = (c: number) => {
    const g = new Graphics();
    g.poly(chamferPoly(S * 0.86, S * 0.86, S * 0.22)).fill({ color: c });
    g.poly(chamferPoly(S * 0.58, S * 0.58, S * 0.15)).fill({ color: bg });
    g.poly(chamferPoly(S * 0.3, S * 0.3, S * 0.08)).fill({ color: c });
    return bake(renderer, g, S);
  };

  const big = (c: number) => {
    const g = new Graphics();
    g.poly(chamferPoly(S * 0.9, S * 0.9, S * 0.24)).fill({ color: c });
    g.poly(chamferPoly(S * 0.68, S * 0.68, S * 0.18)).fill({ color: bg });
    g.poly(chamferPoly(S * 0.52, S * 0.52, S * 0.13)).fill({ color: c });
    g.poly(chamferPoly(S * 0.3, S * 0.3, S * 0.08)).fill({ color: bg });
    hudBrackets(g, S * 0.9, S * 0.9, S * 0.2, text, 3, 3);
    return bake(renderer, g, S + 12);
  };

  const holdTail = (c: number) => {
    const g = new Graphics();
    g.poly(chamferPoly(S * 0.5, S * 0.5, S * 0.13)).fill({ color: bg }).stroke({ width: 5, color: c });
    return bake(renderer, g, S);
  };

  const rollHead = (() => {
    const g = new Graphics();
    g.poly(chamferPoly(S * 0.86, S * 0.86, S * 0.22)).fill({ color: warn });
    g.poly(chamferPoly(S * 0.62, S * 0.62, S * 0.16)).fill({ color: bg });
    const a = S * 0.14;
    for (const dx of [-a * 0.9, a * 0.9]) {
      g.moveTo(dx - a * 0.6, -a).lineTo(dx + a * 0.4, 0).lineTo(dx - a * 0.6, a);
    }
    g.stroke({ width: 6, color: warn, join: 'miter' });
    return bake(renderer, g, S);
  })();

  const mash = (() => {
    const g = new Graphics();
    const s = S * 1.7;
    g.poly(octPoly(s, s * 0.22)).fill({ color: hex(p.accent), alpha: 0.18 }).stroke({ width: 4, color: hex(p.accent) });
    g.poly(octPoly(s * 0.78, s * 0.17)).stroke({ width: 2, color: hex(p.accent), alpha: 0.6 });
    hudBrackets(g, s, s, s * 0.16, text, 3, 8);
    return bake(renderer, g, s + 24);
  })();

  const mine = (() => {
    const g = new Graphics();
    g.poly(chamferPoly(S * 0.74, S * 0.74, S * 0.2)).fill({ color: bg }).stroke({ width: 4, color: err });
    const a = S * 0.18;
    g.moveTo(-a, -a).lineTo(a, a).moveTo(a, -a).lineTo(-a, a).stroke({ width: 7, color: err, cap: 'square' });
    return bake(renderer, g, S);
  })();

  const collect = (() => {
    const g = new Graphics();
    const r = S * 0.3;
    g.poly([0, -r, r, 0, 0, r, -r, 0]).fill({ color: bg }).stroke({ width: 4, color: text });
    const q = r * 0.42;
    g.poly([0, -q, q, 0, 0, q, -q, 0]).fill({ color: text });
    return bake(renderer, g, S);
  })();

  const receptor = (() => {
    const g = new Graphics();
    g.poly(chamferPoly(S * 0.92, S * 0.92, S * 0.24)).stroke({ width: 3, color: 0xffffff, alpha: 0.9 });
    hudBrackets(g, S * 0.92, S * 0.92, S * 0.18, 0xffffff, 3, 6);
    return bake(renderer, g, S + 20);
  })();

  const particle = (() => {
    const g = new Graphics();
    g.rect(-4, -4, 8, 8).fill({ color: 0xffffff });
    return bake(renderer, g, 10, 1);
  })();

  const spark = (() => {
    const g = new Graphics();
    g.poly([-10, -1.5, 10, -1.5, 10, 1.5, -10, 1.5]).fill({ color: 0xffffff });
    return bake(renderer, g, 22, 1);
  })();

  const flash = canvasTexture(256, 4, (ctx) => {
    const grad = ctx.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.15, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 4);
  });

  const glow = canvasTexture(128, 128, (ctx) => {
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0.8)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.25)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  });

  const word = (label: string, color: number, size = 34) => {
    const t = new Text({
      text: label,
      style: { fontFamily: 'IBM Plex Mono', fontSize: size, fontWeight: '600', fill: color, letterSpacing: 4 },
    });
    t.anchor.set(0.5);
    return bake(renderer, t, Math.max(t.width, t.height) + 16);
  };

  return {
    tap: [tap(lanes[0]), tap(lanes[1])],
    big: [big(lanes[0]), big(lanes[1])],
    holdTail: [holdTail(lanes[0]), holdTail(lanes[1])],
    rollHead,
    mash,
    mine,
    collect,
    receptor,
    particle,
    spark,
    flash,
    glow,
    judgement: [
      word('PERFECT', hex(p.judgePerfect)),
      word('GREAT', hex(p.judgeGreat)),
      word('GOOD', hex(p.judgeGood)),
      word('MISS', hex(p.judgeMiss)),
    ],
    extra: {
      big: word('BIG!', text, 22),
      break: word('BREAK', err, 26),
      mine: word('OUCH', err, 26),
      clear: word('CLEAR', hex(p.success), 26),
    },
    white: Texture.WHITE,
  };
};

export const destroyTextures = (bank: TextureBank): void => {
  const all: Texture[] = [
    ...bank.tap, ...bank.big, ...bank.holdTail, bank.rollHead, bank.mash, bank.mine, bank.collect,
    bank.receptor, bank.particle, bank.spark, bank.flash, bank.glow, ...bank.judgement, ...Object.values(bank.extra),
  ];
  for (const t of all) t.destroy(true);
};
