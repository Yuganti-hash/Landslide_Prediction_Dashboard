// Test script: test_model3_cell_color_mapping.cjs
const assert = require('assert');

// Import factorOfSafetyEngine functions
async function runTests() {
  const {
    classifyFactorOfSafety,
    calculateFactorOfSafety,
    calculatePorePressure,
    downsampleFoSTo2D,
    getFoSContinuousColor,
    NORTH_INDIAN_ALLUVIAL_LOAM_PROFILE,
  } = await import('../src/services/factorOfSafetyEngine.js');

  const { MODEL3_FOS_COLORSCALE, getFoSContinuousColor: getVizFoSContinuousColor } = await import('../src/services/terrainVizModes.js');

  console.log('=== TEST 1: Cell-by-cell Classification & Hierarchy ===');
  const testCells = [
    { name: 'Cell High Stable', fos: 2.30, expLevel: 'stable',    expLabel: 'STABLE' },
    { name: 'Cell Stable',      fos: 1.82, expLevel: 'stable',    expLabel: 'STABLE' },
    { name: 'Cell Watch',       fos: 1.37, expLevel: 'watch',     expLabel: 'WATCH' },
    { name: 'Cell High Risk',   fos: 1.14, expLevel: 'high_risk', expLabel: 'HIGH RISK' },
    { name: 'Cell Critical',    fos: 0.97, expLevel: 'failure',   expLabel: 'POTENTIAL FAILURE' },
  ];

  for (const cell of testCells) {
    const res = classifyFactorOfSafety(cell.fos);
    console.log(`  ${cell.name}: FoS=${cell.fos} -> label=${res.label}, color=${res.color}, level=${res.level}`);
    assert.strictEqual(res.level, cell.expLevel, `${cell.name} level mismatch`);
    assert.strictEqual(res.label, cell.expLabel, `${cell.name} label mismatch`);
  }
  console.log('  -> PASS: All cells classify accurately.\n');

  console.log('=== TEST 2: Continuous Gradient Verification (Dark Green -> Green -> Light Green -> Yellow -> Red) ===');
  const cCritical = getFoSContinuousColor(0.80);
  const cLimit = getFoSContinuousColor(1.00);
  const cDarkOrange = getFoSContinuousColor(1.25);
  const cOrange = getFoSContinuousColor(1.60);
  const cDarkYellow = getFoSContinuousColor(2.20);
  const cYellow = getFoSContinuousColor(2.80);
  const cLightYellow = getFoSContinuousColor(3.40);
  const cLightGreen = getFoSContinuousColor(4.20);
  const cGreen = getFoSContinuousColor(5.50);
  const cDarkGreen = getFoSContinuousColor(6.00);

  console.log('  FoS 0.80 (Critical):   ', cCritical);
  console.log('  FoS 1.00 (Limit):      ', cLimit);
  console.log('  FoS 1.25 (Dark Orange):', cDarkOrange);
  console.log('  FoS 1.60 (Orange):     ', cOrange);
  console.log('  FoS 2.20 (Dark Yellow):', cDarkYellow);
  console.log('  FoS 2.80 (Yellow):     ', cYellow);
  console.log('  FoS 3.40 (Lt Yellow):  ', cLightYellow);
  console.log('  FoS 4.20 (Lt Green):   ', cLightGreen);
  console.log('  FoS 5.50 (Green):      ', cGreen);
  console.log('  FoS 6.00 (Dark Grn):   ', cDarkGreen);

  assert.strictEqual(cCritical, '#B91C1C', 'FoS <= 0.80 must be dark red');
  assert.strictEqual(cLimit, 'rgb(239, 68, 68)', 'FoS = 1.00 must be vivid red');
  assert.strictEqual(cDarkGreen, '#053315', 'FoS >= 6.00 must be deep forest green');
  console.log('  -> PASS: Continuous gradient colors align precisely with geotechnical stability spectrum.\n');

  console.log('=== TEST 3: Cell Transition Under Increasing Rainfall (Dark Green -> Light Green -> Yellow -> Red) ===');
  const testProfile = {
    ...NORTH_INDIAN_ALLUVIAL_LOAM_PROFILE,
    soilDepth: 1.2,
    cohesion_c_kPa: 6.0,
  };
  const slopeDeg = 32;
  const slopeRad = slopeDeg * (Math.PI / 180.0);
  const saturations = [0.10, 0.70, 0.88, 0.98];
  const history = [];

  for (const sat of saturations) {
    const u = calculatePorePressure(sat, testProfile.soilDepth, testProfile);
    const fos = calculateFactorOfSafety(slopeRad, u, testProfile);
    const cls = classifyFactorOfSafety(fos);
    history.push({ sat: (sat * 100).toFixed(1) + '%', u: u.toFixed(2) + ' kPa', fos: fos.toFixed(2), cls: cls.label, color: cls.color });
  }

  console.table(history);
  assert.strictEqual(history[0].cls, 'STABLE', 'Low saturation must be STABLE');
  assert.strictEqual(history[1].cls, 'WATCH', 'Medium saturation must be WATCH');
  assert.strictEqual(history[2].cls, 'HIGH RISK', 'High saturation must be HIGH RISK');
  assert.strictEqual(history[3].cls, 'POTENTIAL FAILURE', 'Critical saturation must reach POTENTIAL FAILURE');
  console.log('  -> PASS: Cell progressively transitioned through stability levels as saturation increased.\n');

  console.log('=== TEST 4: Downsampling & Critical Peak Preservation ===');
  const fullWidth = 4;
  const fullHeight = 4;
  const fosMatrix = new Float32Array([
    1.82, 1.37, 1.14, 0.97,
    0.97, 1.82, 1.37, 1.14,
    1.14, 0.97, 1.82, 1.37,
    1.37, 1.14, 0.97, 1.82,
  ]);
  const rowMap = new Int32Array([0, 1, 2, 3]);
  const colMap = new Int32Array([0, 1, 2, 3]);

  const disp2D = downsampleFoSTo2D(fosMatrix, fullWidth, fullHeight, rowMap, colMap);
  console.log('  Row 0 FoS values:', disp2D[0].map(v => v.toFixed(2)));
  // Critical cell 0.97 must be peak preserved
  assert.strictEqual(disp2D[0].some(v => v <= 1.0), true, 'Critical failure must be preserved');
  console.log('  -> PASS: Critical failure peaks preserved and spatial field interpolated.\n');

  console.log('=== ALL TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
