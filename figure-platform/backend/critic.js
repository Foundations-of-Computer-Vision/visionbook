/**
 * critic.js — shared critic (evaluator) definition
 *
 * Used by the web generation pipeline.
 * Edit this file to change what the critic looks for, how it scores, or what it outputs.
 */

const { generateWithModel } = require('./models');
const { screenshotHtml } = require('./runtime-helpers');
const { extractPayloadFromHtml, formatPayload } = require('./generation');

const CRITIC_DEFAULT_MODEL = 'claude-opus-4.7';
const CRITIC_MAX_TOKENS = 8196;
// Change this value to start a new evaluation experiment namespace.
const CRITIC_EXPERIMENT_BASE = 'default_critic';

// ── One-shot calibration example (mpkqucxkwn9z1 — epipolar geometry figure) ──
const EXAMPLE_PAYLOAD = "<!-- @FIGURE_UI_BEGIN -->\n<label title=\"Rotating Camera 2 changes its image plane orientation and therefore where the red ray projects as an epipolar line.\">\n  Rotate Camera 2: <span id=\"rotationCamera2Value\">0°</span>\n  <input id=\"rotationCamera2\" type=\"range\" min=\"0\" max=\"360\" step=\"1\" value=\"0\">\n</label>\n<label title=\"Translating Camera 2 changes the stereo baseline T and shifts the epipole and epipolar line.\">\n  Translate Camera 2: <span id=\"translationCamera2Value\">0.0</span>\n  <input id=\"translationCamera2\" type=\"range\" min=\"-10\" max=\"10\" step=\"0.1\" value=\"0\">\n</label>\n<div style=\"display:flex;gap:4px;flex-wrap:wrap;width:230px;\">\n  <button id=\"step0\">Initial Setup</button>\n  <button id=\"step1\">Rotate Camera 2</button>\n  <button id=\"step2\">Translate Camera 2</button>\n</div>\n<div id=\"stepNarration\" style=\"max-width:245px;line-height:1.28;background:rgba(255,255,255,0.9);border:1px solid #d8d8d8;border-radius:6px;padding:7px 9px;\">\n  Here, you see the red ray from Camera 1 and its red epipolar-line projection on image plane 2.\n</div>\n<!-- @FIGURE_UI_END -->\n// @FIGURE_CODE_BEGIN\nrenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));\n\nconst state = {\n  rotationCamera2: 0,\n  translationCamera2: 0,\n  activeStep: 0,\n  tween: null\n};\n\nconst BLACK = 0x111318;\nconst SOFT_BLACK = 0x1b1d22;\nconst RED = 0xff1010;\nconst GREEN = 0x22e000;\nconst BLUE = 0x2878ff;\nconst CYAN = 0x60f3ef;\nconst MAGENTA = 0xff76b7;\nconst WHITE = 0xffffff;\n\nconst fixedGroup = new THREE.Group();\nconst dynamicGroup = new THREE.Group();\nscene.add(fixedGroup, dynamicGroup);\n\nconst worldUp = new THREE.Vector3(0, 1, 0);\nconst C1 = new THREE.Vector3(-4.65, -1.65, -0.12);\nconst P = new THREE.Vector3(0.75, 1.95, 0.56);\nconst rayDir1 = new THREE.Vector3().subVectors(P, C1).normalize();\n\nfunction disposeGroup(group) {\n  group.traverse(obj => {\n    if (obj.geometry) obj.geometry.dispose?.();\n    if (obj.material) {\n      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose?.());\n      else obj.material.dispose?.();\n    }\n  });\n  group.clear();\n}\n\nfunction makeBasisFromNormal(n) {\n  let u = new THREE.Vector3().crossVectors(worldUp, n);\n  if (u.lengthSq() < 1e-7) u = new THREE.Vector3(1, 0, 0).cross(n);\n  u.normalize();\n  const v = new THREE.Vector3().crossVectors(n, u).normalize();\n  return { u, v };\n}\n\nfunction addCylinderBetween(parent, a, b, radius, color, opacity = 1, radial = 18) {\n  const dir = new THREE.Vector3().subVectors(b, a);\n  const len = dir.length();\n  if (len < 1e-6) return null;\n  const geom = new THREE.CylinderGeometry(radius, radius, len, radial);\n  const mat = new THREE.MeshBasicMaterial({\n    color,\n    transparent: opacity < 1,\n    opacity,\n    depthWrite: opacity >= 0.98\n  });\n  const mesh = new THREE.Mesh(geom, mat);\n  mesh.position.copy(a).add(b).multiplyScalar(0.5);\n  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());\n  parent.add(mesh);\n  return mesh;\n}\n\nfunction addConeAt(parent, tip, dir, radius, height, color) {\n  const d0 = dir.clone().normalize();\n  const geom = new THREE.ConeGeometry(radius, height, 28);\n  const mat = new THREE.MeshBasicMaterial({ color });\n  const cone = new THREE.Mesh(geom, mat);\n  cone.position.copy(tip).addScaledVector(d0, -height / 2);\n  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d0);\n  parent.add(cone);\n  return cone;\n}\n\nfunction addArrow(parent, origin, dir, length, color, radius = 0.022, headScale = 1) {\n  const d0 = dir.clone().normalize();\n  const headH = Math.min(0.38 * headScale, Math.max(0.15, length * 0.26));\n  const shaftEnd = origin.clone().addScaledVector(d0, Math.max(length - headH * 0.72, 0.01));\n  const tip = origin.clone().addScaledVector(d0, length);\n  addCylinderBetween(parent, origin, shaftEnd, radius, color, 1, 16);\n  addConeAt(parent, tip, d0, radius * 5.7 * headScale, headH, color);\n  return tip;\n}\n\nfunction addDashedSegment(parent, a, b, color = BLACK, radius = 0.018, dash = 0.25, gap = 0.17) {\n  const delta = new THREE.Vector3().subVectors(b, a);\n  const len = delta.length();\n  if (len < 1e-6) return;\n  const dir = delta.clone().normalize();\n  for (let t = 0; t < len; t += dash + gap) {\n    const t2 = Math.min(t + dash, len);\n    addCylinderBetween(\n      parent,\n      a.clone().addScaledVector(dir, t),\n      a.clone().addScaledVector(dir, t2),\n      radius,\n      color,\n      1,\n      12\n    );\n  }\n}\n\nfunction addThickPolyline(parent, points, color = BLACK, radius = 0.026, closed = false) {\n  const n = closed ? points.length : points.length - 1;\n  for (let i = 0; i < n; i++) {\n    addCylinderBetween(parent, points[i], points[(i + 1) % points.length], radius, color, 1, 16);\n  }\n}\n\nfunction addPlanePatch(parent, corners, color = WHITE, opacity = 0.16) {\n  const geom = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);\n  geom.setIndex([0, 1, 2, 3, 4, 5]);\n  const mat = new THREE.MeshBasicMaterial({\n    color,\n    transparent: true,\n    opacity,\n    side: THREE.DoubleSide,\n    depthWrite: false\n  });\n  const mesh = new THREE.Mesh(geom, mat);\n  parent.add(mesh);\n  return mesh;\n}\n\nfunction addPlaneOutline(parent, center, normal, width, height, color = BLACK, radius = 0.028) {\n  const { u, v } = makeBasisFromNormal(normal);\n  const corners = [\n    center.clone().addScaledVector(u, -width / 2).addScaledVector(v, -height / 2),\n    center.clone().addScaledVector(u, width / 2).addScaledVector(v, -height / 2),\n    center.clone().addScaledVector(u, width / 2).addScaledVector(v, height / 2),\n    center.clone().addScaledVector(u, -width / 2).addScaledVector(v, height / 2)\n  ];\n  addPlanePatch(parent, corners, WHITE, 0.10);\n  addThickPolyline(parent, corners, color, radius, true);\n  return { corners, u, v, center, normal: normal.clone(), width, height };\n}\n\nfunction addCamera(parent, center, planeCorners, facingDir, labelSide = 1) {\n  const body = new THREE.Mesh(\n    new THREE.SphereGeometry(0.22, 40, 20),\n    new THREE.MeshBasicMaterial({ color: BLACK })\n  );\n  body.position.copy(center);\n  parent.add(body);\n\n  const aperture = new THREE.Mesh(\n    new THREE.SphereGeometry(0.12, 32, 16),\n    new THREE.MeshBasicMaterial({ color: 0x000000 })\n  );\n  aperture.position.copy(center).addScaledVector(facingDir.clone().normalize(), 0.035);\n  parent.add(aperture);\n\n  for (const c of planeCorners) addCylinderBetween(parent, center, c, 0.021, BLACK, 1, 14);\n\n  const base = center.clone().add(new THREE.Vector3(0.34 * labelSide, 0.00, -0.06));\n  addCylinderBetween(parent, center, base, 0.03, BLACK, 1, 14);\n}\n\nfunction addPoint(parent, pos, fillColor, radius = 0.115, outlineColor = BLACK, outlineScale = 1.38) {\n  const halo = new THREE.Mesh(\n    new THREE.SphereGeometry(radius * outlineScale, 36, 18),\n    new THREE.MeshBasicMaterial({ color: outlineColor })\n  );\n  halo.position.copy(pos);\n  parent.add(halo);\n\n  const dot = new THREE.Mesh(\n    new THREE.SphereGeometry(radius, 36, 18),\n    new THREE.MeshBasicMaterial({ color: fillColor })\n  );\n  dot.position.copy(pos);\n  parent.add(dot);\n  return dot;\n}\n\nfunction projectFromCameraToPlane(cameraCenter, objectPoint, planeCenter, planeNormal) {\n  const ray = new THREE.Vector3().subVectors(objectPoint, cameraCenter);\n  const denom = planeNormal.dot(ray);\n  if (Math.abs(denom) < 1e-7) return planeCenter.clone();\n  const t = planeNormal.dot(new THREE.Vector3().subVectors(planeCenter, cameraCenter)) / denom;\n  return cameraCenter.clone().addScaledVector(ray, t);\n}\n\nfunction clipLineToPlaneRect(a, b, center, u, v, width, height) {\n  const ap = new THREE.Vector3().subVectors(a, center);\n  const bp = new THREE.Vector3().subVectors(b, center);\n  const ax = ap.dot(u), ay = ap.dot(v);\n  const bx = bp.dot(u), by = bp.dot(v);\n  const dx = bx - ax, dy = by - ay;\n  const hw = width / 2, hh = height / 2;\n  const ts = [];\n\n  function addT(t) {\n    if (!Number.isFinite(t)) return;\n    const x = ax + dx * t;\n    const y = ay + dy * t;\n    if (x >= -hw - 1e-5 && x <= hw + 1e-5 && y >= -hh - 1e-5 && y <= hh + 1e-5) ts.push(t);\n  }\n\n  if (Math.abs(dx) > 1e-9) {\n    addT((-hw - ax) / dx);\n    addT((hw - ax) / dx);\n  }\n  if (Math.abs(dy) > 1e-9) {\n    addT((-hh - ay) / dy);\n    addT((hh - ay) / dy);\n  }\n\n  ts.sort((m, n) => m - n);\n  const unique = ts.filter((t, i) => i === 0 || Math.abs(t - ts[i - 1]) > 1e-4);\n  if (unique.length >= 2) return [a.clone().lerp(b, unique[0]), a.clone().lerp(b, unique[unique.length - 1])];\n\n  const localDir = new THREE.Vector2(dx, dy);\n  if (localDir.lengthSq() < 1e-9) {\n    return [\n      center.clone().addScaledVector(u, -hw),\n      center.clone().addScaledVector(u, hw)\n    ];\n  }\n  localDir.normalize();\n  const local = new THREE.Vector2(ax, ay);\n  const tClosest = -local.dot(localDir);\n  const cx = ax + localDir.x * tClosest;\n  const cy = ay + localDir.y * tClosest;\n  const span = Math.sqrt(hw * hw + hh * hh);\n  return [\n    center.clone().addScaledVector(u, cx - localDir.x * span).addScaledVector(v, cy - localDir.y * span),\n    center.clone().addScaledVector(u, cx + localDir.x * span).addScaledVector(v, cy + localDir.y * span)\n  ];\n}\n\nfunction addCurvedArrow(parent, start, control, end, color, radius = 0.032) {\n  const curve = new THREE.QuadraticBezierCurve3(start, control, end);\n  const tube = new THREE.Mesh(\n    new THREE.TubeGeometry(curve, 96, radius, 12, false),\n    new THREE.MeshBasicMaterial({ color })\n  );\n  parent.add(tube);\n  addConeAt(parent, end, curve.getTangent(1).normalize(), 0.22, 0.44, color);\n}\n\nfunction setSerif(labelEntry, weight = 'normal') {\n  labelEntry.div.style.fontFamily = 'Georgia, Times New Roman, serif';\n  labelEntry.div.style.fontWeight = weight;\n  return labelEntry;\n}\n\nconst plane1Normal = rayDir1.clone();\nconst basis1 = makeBasisFromNormal(plane1Normal);\nconst p1 = C1.clone().addScaledVector(rayDir1, 2.78);\nconst plane1Center = p1.clone()\n  .addScaledVector(basis1.u, -0.60)\n  .addScaledVector(basis1.v, 0.06);\n\nconst plane1 = addPlaneOutline(fixedGroup, plane1Center, plane1Normal, 3.05, 3.62, BLACK, 0.029);\naddCamera(fixedGroup, C1, plane1.corners, plane1Normal, 1);\n\nconst rayEnd = C1.clone().addScaledVector(rayDir1, 8.75);\naddCylinderBetween(fixedGroup, C1, rayEnd, 0.052, RED, 1, 24);\naddPoint(fixedGroup, p1, RED, 0.115);\naddPoint(fixedGroup, P, CYAN, 0.12);\n\nconst axisOrigin1 = plane1Center.clone().addScaledVector(plane1Normal, 0.10);\nconst x1Tip = addArrow(fixedGroup, axisOrigin1, plane1.u.clone().multiplyScalar(-1), 1.13, GREEN, 0.019, 0.92);\nconst y1Tip = addArrow(fixedGroup, axisOrigin1, plane1.v, 1.16, GREEN, 0.019, 0.92);\nconst z1Tip = addArrow(fixedGroup, axisOrigin1, plane1Normal, 0.93, GREEN, 0.019, 0.92);\n\nfunction camera2Center() {\n  return new THREE.Vector3(\n    4.20 + state.translationCamera2 * 0.18,\n    -1.62,\n    0.08 + state.translationCamera2 * 0.052\n  );\n}\n\nfunction camera2Normal() {\n  const base = new THREE.Vector3(-1.66, 0.78, 0.08).normalize();\n  return base.applyAxisAngle(worldUp, THREE.MathUtils.degToRad(state.rotationCamera2)).normalize();\n}\n\nconst labels = {\n  camera1: setSerif(addLabel('Camera 1', C1.clone().add(new THREE.Vector3(-0.76, -0.45, -0.03)), { fontSize: '34px', color: '#000' })),\n  image1: addLabel('image plane 1', plane1.corners[3].clone().add(new THREE.Vector3(-0.05, 0.23, 0)), { fontSize: '13px', color: '#111', background: 'rgba(255,255,255,0.78)' }),\n  p1: setSerif(addLabel('p<sub>1</sub>', p1.clone().add(new THREE.Vector3(-0.28, 0.34, 0.03)), { fontSize: '44px', color: '#000' }), 'bold'),\n  P: setSerif(addLabel('P', P.clone().add(new THREE.Vector3(0.02, 0.34, 0.02)), { fontSize: '25px', color: '#000' }), 'bold'),\n  ray: addLabel('ray from Camera 1', C1.clone().lerp(P, 0.55).add(new THREE.Vector3(0.10, 0.17, 0.05)), { fontSize: '13px', color: '#d40000', background: 'rgba(255,255,255,0.80)' }),\n  axes1: addLabel('coordinate axes 1', axisOrigin1.clone().add(new THREE.Vector3(-0.55, 0.22, 0.02)), { fontSize: '12px', color: '#17c900', background: 'rgba(255,255,255,0.75)' }),\n  x1: addLabel('x<sub>1</sub>', x1Tip, { fontSize: '14px', color: '#16c900', bold: true }),\n  y1: addLabel('y<sub>1</sub>', y1Tip, { fontSize: '14px', color: '#16c900', bold: true }),\n  z1: addLabel('z<sub>1</sub>', z1Tip, { fontSize: '14px', color: '#16c900', bold: true }),\n\n  camera2: setSerif(addLabel('Camera 2', new THREE.Vector3(), { fontSize: '34px', color: '#000' })),\n  image2: addLabel('image plane 2', new THREE.Vector3(), { fontSize: '13px', color: '#111', background: 'rgba(255,255,255,0.78)' }),\n  p2: setSerif(addLabel('p<sub>2</sub> ?', new THREE.Vector3(), { fontSize: '44px', color: '#000' }), 'bold'),\n  epipolar: addLabel('epipolar line on image plane 2', new THREE.Vector3(), { fontSize: '13px', color: '#d40000', background: 'rgba(255,255,255,0.82)' }),\n  rayProjection: addLabel('projection of Camera 1 ray', new THREE.Vector3(), { fontSize: '12px', color: '#d40000', background: 'rgba(255,255,255,0.78)' }),\n  e2: addLabel('e<sub>2</sub> = projection of Camera 1', new THREE.Vector3(), { fontSize: '12px', color: '#000', bold: true, background: 'rgba(255,255,255,0.78)' }),\n  p1to2: addLabel('&pi;<sub>2</sub>(p<sub>1</sub>)', new THREE.Vector3(), { fontSize: '12px', color: '#008c8c', bold: true, background: 'rgba(255,255,255,0.78)' }),\n  pointP2: addLabel('projection of P', new THREE.Vector3(), { fontSize: '12px', color: '#158000', background: 'rgba(255,255,255,0.78)' }),\n  x2: addLabel('x<sub>2</sub>', new THREE.Vector3(), { fontSize: '14px', color: '#1d63e8', bold: true }),\n  y2: addLabel('y<sub>2</sub>', new THREE.Vector3(), { fontSize: '14px', color: '#1d63e8', bold: true }),\n  z2: addLabel('z<sub>2</sub>', new THREE.Vector3(), { fontSize: '14px', color: '#1d63e8', bold: true }),\n  axes2: addLabel('coordinate axes 2', new THREE.Vector3(), { fontSize: '12px', color: '#1d63e8', background: 'rgba(255,255,255,0.75)' }),\n  RT: setSerif(addLabel('R,T', new THREE.Vector3(), { fontSize: '54px', color: '#18c900' }), 'bold'),\n  T: addLabel('T', new THREE.Vector3(), { fontSize: '20px', color: '#18c900', bold: true, background: 'rgba(255,255,255,0.62)' })\n};\n\nconst demoSteps = [\n  {\n    title: 'Initial Setup',\n    narration: 'Here, you see Camera 1 and Camera 2 with their respective image planes. The red line is the ray from Camera 1; its projection is the red epipolar line on image plane 2.',\n    rotationCamera2: 0,\n    translationCamera2: 0\n  },\n  {\n    title: 'Rotate Camera 2',\n    narration: 'As we rotate Camera 2, the image plane changes orientation, so the red epipolar line shifts on image plane 2.',\n    rotationCamera2: 45,\n    translationCamera2: 0\n  },\n  {\n    title: 'Translate Camera 2',\n    narration: 'Translating Camera 2 changes the baseline T. The epipole and the red epipolar line move, changing the candidate locations for p\\u2082.',\n    rotationCamera2: 45,\n    translationCamera2: 5\n  }\n];\n\nfunction updateScene() {\n  disposeGroup(dynamicGroup);\n\n  const C2 = camera2Center();\n  const n2 = camera2Normal();\n  const b2 = makeBasisFromNormal(n2);\n  const plane2Center = C2.clone().addScaledVector(n2, 2.30)\n    .addScaledVector(b2.u, -0.05)\n    .addScaledVector(b2.v, 0.04);\n\n  const plane2 = addPlaneOutline(dynamicGroup, plane2Center, n2, 3.10, 3.64, BLACK, 0.029);\n  addCamera(dynamicGroup, C2, plane2.corners, n2, -1);\n\n  const e2 = projectFromCameraToPlane(C2, C1, plane2Center, n2);\n  const p2 = projectFromCameraToPlane(C2, P, plane2Center, n2);\n  const p1OnPlane2 = projectFromCameraToPlane(C2, p1, plane2Center, n2);\n  const [lineA, lineB] = clipLineToPlaneRect(e2, p2, plane2Center, plane2.u, plane2.v, plane2.width, plane2.height);\n\n  addDashedSegment(dynamicGroup, C1, C2, BLACK, 0.018, 0.26, 0.18);\n  addDashedSegment(dynamicGroup, C2, P, BLACK, 0.018, 0.25, 0.17);\n  addDashedSegment(dynamicGroup, C1, e2, BLACK, 0.016, 0.23, 0.17);\n  addDashedSegment(dynamicGroup, P, p2, BLACK, 0.016, 0.23, 0.16);\n  addDashedSegment(dynamicGroup, p1, p1OnPlane2, BLACK, 0.016, 0.23, 0.16);\n\n  addCylinderBetween(dynamicGroup, lineA, lineB, 0.048, RED, 1, 24);\n\n  const epipolarPlaneGeom = new THREE.BufferGeometry().setFromPoints([C1, C2, P]);\n  epipolarPlaneGeom.setIndex([0, 1, 2]);\n  const epipolarPlane = new THREE.Mesh(\n    epipolarPlaneGeom,\n    new THREE.MeshBasicMaterial({\n      color: MAGENTA,\n      transparent: true,\n      opacity: 0.10,\n      side: THREE.DoubleSide,\n      depthWrite: false\n    })\n  );\n  dynamicGroup.add(epipolarPlane);\n\n  addPoint(dynamicGroup, e2, RED, 0.112);\n  addPoint(dynamicGroup, p2, GREEN, 0.112);\n  addPoint(dynamicGroup, p1OnPlane2, CYAN, 0.098);\n\n  const origin2 = plane2Center.clone().addScaledVector(n2, 0.10);\n  const x2Tip = addArrow(dynamicGroup, origin2, plane2.u.clone().multiplyScalar(-1), 1.12, BLUE, 0.019, 0.92);\n  const y2Tip = addArrow(dynamicGroup, origin2, plane2.v, 1.16, BLUE, 0.019, 0.92);\n  const z2Tip = addArrow(dynamicGroup, origin2, n2, 0.94, BLUE, 0.019, 0.92);\n\n  const tStart = C1.clone().add(new THREE.Vector3(0.05, -0.58, 0.62));\n  const tEnd = C2.clone().add(new THREE.Vector3(-0.05, -0.58, 0.62));\n  addArrow(dynamicGroup, tStart, new THREE.Vector3().subVectors(tEnd, tStart), tStart.distanceTo(tEnd), GREEN, 0.026, 1.08);\n\n  const curveStart = C1.clone().add(new THREE.Vector3(1.05, -1.05, 0.92));\n  const curveEnd = C2.clone().add(new THREE.Vector3(-1.10, -1.05, 0.92));\n  const curveControl = new THREE.Vector3((curveStart.x + curveEnd.x) * 0.5, -3.42, 1.22);\n  addCurvedArrow(dynamicGroup, curveStart, curveControl, curveEnd, GREEN, 0.032);\n\n  labels.camera2.pos.copy(C2).add(new THREE.Vector3(0.76, -0.45, -0.02));\n  labels.image2.pos.copy(plane2.corners[2]).add(new THREE.Vector3(0.06, 0.23, 0.02));\n  labels.p2.pos.copy(p2).add(new THREE.Vector3(-0.33, 0.02, 0.04));\n  labels.epipolar.pos.copy(lineA).lerp(lineB, 0.72).add(new THREE.Vector3(0.04, 0.19, 0.04));\n  labels.rayProjection.pos.copy(lineA).lerp(lineB, 0.42).add(new THREE.Vector3(0.09, -0.16, 0.04));\n  labels.e2.pos.copy(e2).add(new THREE.Vector3(0.20, -0.16, 0.02));\n  labels.p1to2.pos.copy(p1OnPlane2).add(new THREE.Vector3(0.20, 0.15, 0.02));\n  labels.pointP2.pos.copy(p2).add(new THREE.Vector3(0.18, 0.18, 0.02));\n  labels.x2.pos.copy(x2Tip);\n  labels.y2.pos.copy(y2Tip);\n  labels.z2.pos.copy(z2Tip);\n  labels.axes2.pos.copy(origin2).add(new THREE.Vector3(0.54, 0.16, 0.02));\n  labels.T.pos.copy(tStart).lerp(tEnd, 0.5).add(new THREE.Vector3(0, 0.22, 0.02));\n  labels.RT.pos.copy(curveControl).add(new THREE.Vector3(0, -0.20, 0));\n\n  document.getElementById('rotationCamera2Value').textContent = `${Math.round(state.rotationCamera2)}\\u00b0`;\n  document.getElementById('translationCamera2Value').textContent = state.translationCamera2.toFixed(1);\n  document.getElementById('rotationCamera2').value = state.rotationCamera2;\n  document.getElementById('translationCamera2').value = state.translationCamera2;\n\n  for (let i = 0; i < 3; i++) {\n    document.getElementById(`step${i}`).classList.toggle('active', state.activeStep === i);\n  }\n  const step = demoSteps[state.activeStep];\n  document.getElementById('stepNarration').textContent = step ? step.narration : 'Adjust either slider independently to explore how camera pose changes the epipolar constraint.';\n}\n\nconst rotationInput = document.getElementById('rotationCamera2');\nconst translationInput = document.getElementById('translationCamera2');\n\nrotationInput.addEventListener('input', () => {\n  state.tween = null;\n  state.activeStep = -1;\n  state.rotationCamera2 = Number(rotationInput.value);\n  updateScene();\n});\n\ntranslationInput.addEventListener('input', () => {\n  state.tween = null;\n  state.activeStep = -1;\n  state.translationCamera2 = Number(translationInput.value);\n  updateScene();\n});\n\nfunction goToStep(i) {\n  const target = demoSteps[i];\n  if (!target) return;\n\n  state.activeStep = i;\n  state.tween = {\n    startTime: performance.now(),\n    duration: 1000,\n    fromRotation: state.rotationCamera2,\n    fromTranslation: state.translationCamera2,\n    toRotation: target.rotationCamera2,\n    toTranslation: target.translationCamera2\n  };\n\n  function tick(now) {\n    if (!state.tween) return;\n    const t = Math.min((now - state.tween.startTime) / state.tween.duration, 1);\n    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;\n    state.rotationCamera2 = THREE.MathUtils.lerp(state.tween.fromRotation, state.tween.toRotation, eased);\n    state.translationCamera2 = THREE.MathUtils.lerp(state.tween.fromTranslation, state.tween.toTranslation, eased);\n    updateScene();\n\n    if (t < 1) {\n      requestAnimationFrame(tick);\n    } else {\n      state.rotationCamera2 = state.tween.toRotation;\n      state.translationCamera2 = state.tween.toTranslation;\n      state.tween = null;\n      updateScene();\n    }\n  }\n\n  requestAnimationFrame(tick);\n}\n\ndocument.getElementById('step0').addEventListener('click', () => goToStep(0));\ndocument.getElementById('step1').addEventListener('click', () => goToStep(1));\ndocument.getElementById('step2').addEventListener('click', () => goToStep(2));\nwindow.goToStep = goToStep;\n\ncamera.position.set(0.38, 3.05, 9.65);\ncontrols.target.set(0.02, -0.44, 0.24);\ncamera.zoom = 0.52;\ncamera.lookAt(controls.target);\ncamera.updateProjectionMatrix();\ncontrols.update();\nHOME_POS.copy(camera.position);\nHOME_TARGET.copy(controls.target);\nHOME_ZOOM = camera.zoom;\n\nupdateScene();\n// @FIGURE_CODE_END";

const GOLD_EVAL = {
  discrepancies: [
    'camera shapes differ: they are pyramids when they should be rectangles',
    'there are more labels than the original figure has',
    'there is an extra green arrow labelled T at the bottom',
    'blue and green axis arrows on cameras are 3D when they should be 2D',
  ],
  failure_modes: ['Wrong-Primitives', 'Depth-Wrong', 'Interaction-Broken'],
  geometry_accuracy: 2,
  interactivity_usability: 2,
  faithfulness: 4,
  label_quality: 1,
  concept_accuracy: 5,
  notes: 'Labels are too tiny, Geometry is incorrect, Rotation interaction is broken',
  action_items: [
    'Make the geometry of the cameras rectangles',
    'Remove unnecessary labels and increase font size of other ones',
    'Fix/Remove the rotation interaction since it is broken',
  ],
};

// ── 10 canonical failure modes ─────────────────────────────────────────────────
const FAILURE_MODES = [
  { id: 'Depth-Wrong', desc: '3D depth/perspective interpretation is incorrect' },
  { id: 'Missing-Labels', desc: 'important text annotations are absent' },
  { id: 'Wrong-Primitives', desc: 'incorrect geometric shapes used for the concept' },
  { id: 'Interaction-Broken', desc: 'interactive controls are present but non-functional' },
  { id: 'Interaction-Missing', desc: 'no meaningful interactions beyond basic OrbitControls rotation' },
  { id: 'Camera-Wrong', desc: 'poor initial viewpoint; key content not visible' },
  { id: 'Scale-Wrong', desc: 'element proportions are noticeably off' },
  { id: 'Color-Wrong', desc: "colors don't match the original figure" },
  { id: 'Hallucination', desc: 'elements present that do not appear in the original' },
  { id: 'Concept-Misunderstood', desc: 'the core concept being illustrated is    misrepresented' },
];

// ── 5 primary scored metrics (each 1–5) ────────────────────────────────────────
const SCORE_METRICS = [
  {
    id: 'geometry_accuracy',
    rubric: [
      '5 – All elements represented; plausible positions, connections, proportions',
      '4 – All major elements present; minor position/alignment issues',
      '3 – 1-2 elements missing OR noticeable spatial errors; concept still recognizable',
      '2 – Multiple missing elements OR major spatial errors',
      '1 – Unrecognizable or completely wrong topology',
    ],
  },
  {
    id: 'interactivity_usability',
    note: 'CRITICAL: OrbitControls (mouse drag to rotate/zoom) does NOT count as an interaction. Meaningful interactions = buttons, sliders, toggles, step-through animations, parameter controls built by the developer.',
    rubric: [
      '5 – 3+ meaningful interactions all functional and pedagogically useful; reset button works; guided step-through demo present',
      '4 – 2 meaningful interactions functional and pedagogically useful; reset button present; minor usability issues',
      '3 – 1 meaningful interaction functional and pedagogically useful; no guided demo',
      '2 – Interactions exist in code but are broken or have no visible effect',
      '1 – Only OrbitControls present, or no interactions at all — score MUST be 1',
    ],
  },
  {
    id: 'faithfulness',
    rubric: [
      '5 – Matches original ≥95% (colors, proportions, composition)',
      '4 – Matches ≥85%; recognizable at a glance',
      '3 – Matches ≥65%; general idea clear',
      '2 – Matches <65%; hard to recognize',
      '1 – Completely different or fabricated',
    ],
  },
  {
    id: 'label_quality',
    rubric: [
      '5 – All labels correct, clear, well-sized, well-placed, not cluttered',
      '4 – 1-2 labels have minor issues; rest perfect',
      '3 – Half of labels have issues (size/placement/clarity/clutter)',
      '2 – Most labels problematic or missing',
      '1 – No labels or all wrong/unreadable/severely cluttered',
    ],
  },
  {
    id: 'concept_accuracy',
    rubric: [
      '5 – All concepts accurate; interactions demonstrate correct relationships; no misinformation',
      '4 – Main concept correct; ≤1 minor detail wrong or missing',
      '3 – Main concept present; 2-3 details wrong or missing',
      '2 – Significant errors or fabrications; would mislead students',
      '1 – Completely incorrect or misleading',
    ],
  },
];

// ── Build the system prompt sent to the critic model ─────────────────────────
function buildEvalPrompt(useFewShot = true) {
  const failureModeLines = FAILURE_MODES
    .map(f => `"${f.id}"${' '.repeat(Math.max(1, 24 - f.id.length))}— ${f.desc}`)
    .join('\n');

  const metricLines = SCORE_METRICS.map(m => {
    const header = m.note ? `${m.id} — ${m.note}` : m.id + ':';
    return `${header}\n${m.rubric.map(r => `  ${r}`).join('\n')}`;
  }).join('\n\n');

  const exampleOutput = JSON.stringify(
    Object.fromEntries([
      ['discrepancies', []],
      ['failure_modes', []],
      ...SCORE_METRICS.map(m => [m.id, 3]),
      ['notes', 'one concise sentence summarizing the main strengths and weaknesses'],
      ['action_items', ['Specific actionable improvement 1', 'Specific actionable improvement 2']],
    ]),
    null,
    2
  );

  return `You are a strict critic of generated interactive Three.js 3D figures against original 2D textbook figure images.
You will receive the original source figure image, the generated HTML/JavaScript code, and a rendered screenshot of the generated HTML (if screenshot capture succeeds). Start by using the screenshot to help evaluate the faithfulness of the generated figure to the source figure, listing discrepancies in the primitive elements between what you see in the source figure versus what you see in the generated figure. If the screenshot was not received, mention this in the notes.
Score the generated figure using the rubric and give feedback to improve the figure. Be critical and honest — err toward lower scores when in doubt. Ensure that the output is not a 2D image rendered with Three.js. Do not give credit for things that are absent or barely present. Output ONLY a valid JSON object — no explanation, no markdown, no fences.

INLINE PDF REPLACEMENT STANDARD:
- The rendered screenshot's first frame should be a drop-in replacement for the source image: same apparent crop, zoom, camera angle, perspective/orthographic feel, object scale, label scale, whitespace, and panel layout.
- Penalize wrong camera/view, over-zooming, under-zooming, stretched aspect ratio, shifted object position, changed perspective, missing whitespace, or labels drifting to different relative positions.
- Penalize bulky default UI: visible toolbars, step panels, filled control boxes, large buttons, legends, narration cards, or controls covering geometry/labels.
- Compact edge controls are acceptable only when they teach a real parameter and do not cover important figure content.

SCAFFOLD CONTEXT (provided automatically — do not penalise for missing these):
- THREE, OrbitControls, renderer, scene, orthographic camera, controls, animate loop, ResizeObserver are all pre-wired
- addLabel(text, position3D, {color, fontSize, bold, offset, background}?) — floating HTML label system
- setStandardView({azimuth, polar, heightFraction}?) — frames the camera to scene content
- Reset View is scaffolded but should not appear as visible chrome in inline output; generated code may add at most 2 compact edge controls only when pedagogically necessary

DISCREPANCIES - list 0-5 visual discrepancies between the primitive elements in source figure and the generated figure
- Primitives include color, text size, geometric shapes, geometric relations, camera/view, crop/zoom, label placement, and intrusive UI

FAILURE MODES — list any that apply (use empty array [] if none):
${failureModeLines}

SCORES — integer 1–5 for each field:
${metricLines}

ACTION ITEMS — list 3-5 specific actions to take to improve the scores and remove failure modes
- Be concrete and specific to THIS figure, not generic
- If scores are high (4+), note what works well and minor refinements
- If scores are low, identify the most impactful fixes (geometry issues, missing labels, broken interactions, concept errors)
- Give feedback to both the plan and the generation

Output this exact JSON structure and nothing else:
${exampleOutput}

${useFewShot ? `Here is an example output - study this before scoring. Do not copy these scores; only use them as a reference example for judgement.
Generated code:
${EXAMPLE_PAYLOAD}

Correct evaluation for the above code:
${JSON.stringify(GOLD_EVAL, null, 2)}` : ''}`;
}

function getCriticContext(useFewShot = true) {
  const systemPrompt = buildEvalPrompt(useFewShot);
  return {
    systemPrompt,
    criticVersion: CRITIC_EXPERIMENT_BASE,
  };
}

// ── Finalise raw evaluator output: clamp, derive visual_aesthetics + overall ──
function finaliseEval(evaluation) {
  const scoreKeys = SCORE_METRICS.map(m => m.id);
  for (const key of scoreKeys) {
    evaluation[key] = Math.min(5, Math.max(1, Math.round(Number(evaluation[key]) || 3)));
  }
  // Derived: visual quality proxy
  evaluation.visual_aesthetics = Math.round(
    ((evaluation.geometry_accuracy + evaluation.faithfulness + evaluation.label_quality) / 3) * 10
  ) / 10;
  // Derived: overall average of the 5 primary metrics
  evaluation.overall_average = Math.round(
    (scoreKeys.reduce((s, k) => s + evaluation[k], 0) / scoreKeys.length) * 10
  ) / 10;
  return evaluation;
}

/**
 * Run evaluator model and return finalised rubric scores.
 *
 * @param {{
 *   html: string,
 *   evalImage?: string,
 *   evalMediaType?: string,
 *   model?: string,
 *   maxTokens?: number,
 * }} opts
 */
async function evaluateHtmlWithCritic(opts) {
  const {
    html,
    evalImage,
    evalMediaType = 'image/png',
    model = CRITIC_DEFAULT_MODEL,
    maxTokens = CRITIC_MAX_TOKENS,
    useFewShot = true,
  } = opts || {};

  if (!html) throw new Error('No HTML found for evaluation.');

  // Try to render the generated HTML so the critic can see the actual output.
  // If rendering fails, continue evaluation with available inputs.
  const rendered = await screenshotHtml(html);

  const userContent = [
    ...(evalImage
      ? [
        { type: 'text', text: 'Reference source figure image:' },
        { type: 'image_url', image_url: { url: `data:${evalMediaType};base64,${evalImage}` } },
      ]
      : []),
    ...(rendered?.data
      ? [
        { type: 'text', text: 'Rendered screenshot of the generated HTML output:' },
        { type: 'image_url', image_url: { url: `data:${rendered.mediaType || 'image/jpeg'};base64,${rendered.data}` } },
      ]
      : []),
    {
      type: 'text',
      text: `Here is the generated code to evaluate:\n\n${formatPayload(extractPayloadFromHtml(html) ?? { uiHtml: '', codeJs: html })}\n\nOutput ONLY the JSON evaluation object.`,
    },
  ];

  const { systemPrompt } = getCriticContext(useFewShot);

  let content = await generateWithModel(model, {
    systemPrompt,
    userContent,
    maxTokens,
  });

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) content = fenced[1].trim();
  content = content.trim();

  let evaluation;
  try {
    evaluation = JSON.parse(content);
  } catch {
    throw new Error('Evaluator did not return valid JSON: ' + content.slice(0, 200));
  }

  return finaliseEval(evaluation);
}

module.exports = {
  CRITIC_EXPERIMENT_BASE,
  getCriticContext,
  evaluateHtmlWithCritic,
};
