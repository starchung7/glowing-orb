# Glowing Orb

A small Three.js sketch: a tiny floating orb on a glossy black plane that you
steer around with the keyboard, trailing a fading neon ribbon behind it.

![Glowing orb on a glossy black plane](https://github.com/starchung7/glowing-orb)

## What it is

- A self-illuminated sphere hovers above a clearcoated `MeshPhysicalMaterial`
  floor, with a soft point light tinting the surface around it.
- The orb is locked into a 3/4-view chase camera so it always sits roughly in
  the middle of the frame.
- A continuous `TubeGeometry` trail is rebuilt every frame along a
  `CatmullRomCurve3` through the orb's recent positions; per-vertex vertex
  colors fade with age and use additive blending so the tail dissolves into
  the black background.
- Quasi-random sine-stack bobbing on all three axes makes the orb drift like
  it's suspended in something. The bob amplitude scales up sharply when the
  orb is idle and damps back as it accelerates to full speed.
- Movement uses exponential velocity smoothing — direction changes ease in
  and out instead of snapping. The jump is asymmetric: strong gravity on the
  way up for a quick pop, weak gravity plus a damped soft-landing zone on
  the way down so the orb floats back to its hover height.

## Controls

| Key             | Action          |
| --------------- | --------------- |
| `W` / `↑`       | Move forward    |
| `S` / `↓`       | Move backward   |
| `A` / `←`       | Move left       |
| `D` / `→`       | Move right      |
| `Space`         | Jump            |

## Running locally

Requires Node.js.

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default http://localhost:5173/) and click
the page once so the iframe captures keyboard input.

## Build

```bash
npm run build      # outputs static files to dist/
npm run preview    # serve the built bundle
```

## Stack

- [Three.js](https://threejs.org/) `^0.160` — scene, geometry, materials
- [Vite](https://vitejs.dev/) `^7` — dev server + bundler

## Files

- `index.html` — minimal page with a HUD overlay
- `script.js` — the entire scene (scene setup, controls, physics, trail)
- `package.json` — npm scripts and dependencies
