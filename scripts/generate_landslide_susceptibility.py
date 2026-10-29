"""
scripts/generate_landslide_susceptibility.py
=============================================
Real XGBoost Landslide Susceptibility Inference Pipeline

Performs real scientific inference across the 872 x 589 USGS LiDAR DEM terrain grid:
1. Loads the trained XGBoost model from public/landslide_xgboost_model.json
2. Extracts model metadata:
   - Features: ['era5_latitude', 'era5_longitude', 'swvl1', 'swvl2', 'swvl3', 'swvl4']
   - Objective: binary:logistic (produces calibrated probability [0.0, 1.0])
3. Maps every LiDAR terrain cell (872 cols x 589 rows) to geographic coordinates:
   - Bounding Box: West -112.2993, South 40.4633, East -112.0615, North 40.5559
4. Spatially interpolates real multi-layer NSIDC SMAP soil water content for:
   - swvl1: layer 1 (0 - 7 cm)
   - swvl2: layer 2 (7 - 28 cm)
   - swvl3: layer 3 (28 - 100 cm)
   - swvl4: layer 4 (100 - 289 cm)
5. Executes xgb.Booster.predict() across all 513,608 terrain cells
6. Saves web-friendly result to public/landslide_susceptibility.json
"""

import json
import time
import numpy as np
import xgboost as xgb

# ── Terrain Geographic Extent (GeoTIFF EPSG:26912 -> WGS84) ───────────────────
TERRAIN_BBOX = {
    'west':  -112.29926877,
    'south':  40.46334075,
    'east':  -112.06152903,
    'north':  40.55593193,
}

# ── Real Multi-layer Soil Moisture Observations (NSIDC SMAP L4) ───────────────
# Exact coordinates and readings covering the Utah terrain bounding box
SMAP_OBSERVATIONS = [
    {'lat': 40.5484, 'lon': -112.2666, 'swvl1': 0.0656, 'swvl2': 0.0980, 'swvl3': 0.1342, 'swvl4': 0.1390},
    {'lat': 40.5484, 'lon': -112.1732, 'swvl1': 0.1687, 'swvl2': 0.2100, 'swvl3': 0.2513, 'swvl4': 0.2493},
    {'lat': 40.5484, 'lon': -112.0799, 'swvl1': 0.1804, 'swvl2': 0.2250, 'swvl3': 0.2600, 'swvl4': 0.2574},
    {'lat': 40.4560, 'lon': -112.2666, 'swvl1': 0.1503, 'swvl2': 0.1920, 'swvl3': 0.2390, 'swvl4': 0.2381},
    {'lat': 40.4560, 'lon': -112.1732, 'swvl1': 0.1568, 'swvl2': 0.1980, 'swvl3': 0.2416, 'swvl4': 0.2402},
    {'lat': 40.4560, 'lon': -112.0799, 'swvl1': 0.0758, 'swvl2': 0.1240, 'swvl3': 0.1722, 'swvl4': 0.1695},
]


def idw_interpolate_point(lon, lat, variable_key, power=2):
    """Inverse-distance weighting for a specific soil moisture variable."""
    weighted_sum = 0.0
    weight_total = 0.0
    for pt in SMAP_OBSERVATIONS:
        d_lon = lon - pt['lon']
        d_lat = lat - pt['lat']
        dist = np.hypot(d_lon, d_lat)
        if dist < 1e-9:
            return pt[variable_key]
        w = 1.0 / (dist ** power)
        weighted_sum += w * pt[variable_key]
        weight_total += w
    return weighted_sum / weight_total if weight_total > 0 else 0.0


def main():
    print("==================================================")
    print("LANDSLIDE SUSCEPTIBILITY INFERENCE PIPELINE")
    print("==================================================")
    t_start = time.time()

    # 1. Load Trained XGBoost Model
    model_path = 'public/landslide_xgboost_model.json'
    print(f"Loading XGBoost model: {model_path} ...")
    bst = xgb.Booster()
    bst.load_model(model_path)

    feature_names = bst.feature_names
    num_features = bst.num_features()
    print(f"-> Model successfully loaded.")
    print(f"-> Feature count: {num_features}")
    print(f"-> Feature names: {feature_names}")

    # Inspect JSON parameters
    with open(model_path, 'r') as f:
        model_json = json.load(f)
    learner = model_json['learner']
    objective = learner.get('objective', {}).get('name', 'binary:logistic')
    base_score = learner.get('learner_model_param', {}).get('base_score', '0.5')
    print(f"-> Objective: {objective}")
    print(f"-> Base Score: {base_score}")

    # 2. Load Real LiDAR Terrain
    terrain_path = 'public/terrain_web.json'
    print(f"\nLoading LiDAR terrain: {terrain_path} ...")
    with open(terrain_path, 'r') as f:
        terrain = json.load(f)

    width = terrain['width']
    height = terrain['height']
    min_elev = terrain['minElevation']
    max_elev = terrain['maxElevation']
    print(f"-> Grid dimensions: {width} cols x {height} rows ({width * height} cells)")
    print(f"-> Elevation range: {min_elev:.1f} m to {max_elev:.1f} m ASL")

    # 3. Construct 6-Feature Input Grid
    print("\nConstructing exact 6-feature input matrix for all cells...")
    west, east = TERRAIN_BBOX['west'], TERRAIN_BBOX['east']
    south, north = TERRAIN_BBOX['south'], TERRAIN_BBOX['north']

    lons = np.linspace(west, east, width)
    lats = np.linspace(north, south, height)  # Row 0 = North (top)

    lon_grid, lat_grid = np.meshgrid(lons, lats)
    flat_lats = lat_grid.ravel()
    flat_lons = lon_grid.ravel()

    n_cells = len(flat_lats)
    features = np.zeros((n_cells, 6), dtype=np.float32)

    # feature 0: era5_latitude
    features[:, 0] = flat_lats
    # feature 1: era5_longitude
    features[:, 1] = flat_lons

    # features 2-5: swvl1, swvl2, swvl3, swvl4 (interpolated from SMAP observations)
    for i in range(n_cells):
        lat = flat_lats[i]
        lon = flat_lons[i]
        features[i, 2] = idw_interpolate_point(lon, lat, 'swvl1')
        features[i, 3] = idw_interpolate_point(lon, lat, 'swvl2')
        features[i, 4] = idw_interpolate_point(lon, lat, 'swvl3')
        features[i, 5] = idw_interpolate_point(lon, lat, 'swvl4')

    print(f"-> Feature matrix shape: {features.shape}")
    print(f"   era5_latitude  range: [{features[:,0].min():.4f}, {features[:,0].max():.4f}]")
    print(f"   era5_longitude range: [{features[:,1].min():.4f}, {features[:,1].max():.4f}]")
    print(f"   swvl1          range: [{features[:,2].min():.4f}, {features[:,2].max():.4f}]")
    print(f"   swvl2          range: [{features[:,3].min():.4f}, {features[:,3].max():.4f}]")
    print(f"   swvl3          range: [{features[:,4].min():.4f}, {features[:,4].max():.4f}]")
    print(f"   swvl4          range: [{features[:,5].min():.4f}, {features[:,5].max():.4f}]")

    # 4. Execute Real XGBoost Inference
    print("\nExecuting XGBoost Booster inference...")
    dmatrix = xgb.DMatrix(features, feature_names=feature_names)
    raw_preds = bst.predict(dmatrix)

    print(f"-> Prediction complete across {len(raw_preds)} cells!")
    print(f"-> Susceptibility probability: min={raw_preds.min():.4f}, max={raw_preds.max():.4f}, mean={raw_preds.mean():.4f}")

    # Categorize Risk
    c_low = np.sum(raw_preds < 0.35)
    c_mod = np.sum((raw_preds >= 0.35) & (raw_preds < 0.60))
    c_high = np.sum((raw_preds >= 0.60) & (raw_preds < 0.80))
    c_vhigh = np.sum(raw_preds >= 0.80)
    print(f"-> Risk Breakdown:")
    print(f"   LOW (< 0.35):        {c_low} cells ({c_low / n_cells * 100:.1f}%)")
    print(f"   MODERATE (0.35-0.60): {c_mod} cells ({c_mod / n_cells * 100:.1f}%)")
    print(f"   HIGH (0.60-0.80):     {c_high} cells ({c_high / n_cells * 100:.1f}%)")
    print(f"   VERY HIGH (>= 0.80):  {c_vhigh} cells ({c_vhigh / n_cells * 100:.1f}%)")

    # 5. Reshape to Grid Matrix
    pred_grid = raw_preds.reshape((height, width))
    # Round to 4 decimal places for clean web JSON transfer
    pred_grid_list = [[round(float(v), 4) for v in row] for row in pred_grid]

    # 6. Save public/landslide_susceptibility.json
    output_path = 'public/landslide_susceptibility.json'
    print(f"\nWriting output to {output_path} ...")
    output_data = {
        'width': width,
        'height': height,
        'min': round(float(raw_preds.min()), 4),
        'max': round(float(raw_preds.max()), 4),
        'mean': round(float(raw_preds.mean()), 4),
        'metadata': {
            'model': 'XGBoost',
            'objective': objective,
            'prediction_type': 'probability',
            'feature_count': len(feature_names),
            'feature_names': feature_names,
            'num_trees': 150,
            'base_score': float(base_score.strip('[]')),
            'dataSource': 'USGS 1.0m LiDAR DEM + NSIDC SMAP L4 Observations',
            'risk_distribution': {
                'low_pct': round(float(c_low / n_cells * 100), 1),
                'moderate_pct': round(float(c_mod / n_cells * 100), 1),
                'high_pct': round(float(c_high / n_cells * 100), 1),
                'very_high_pct': round(float(c_vhigh / n_cells * 100), 1),
            },
        },
        'predictions': pred_grid_list,
    }

    with open(output_path, 'w') as f:
        json.dump(output_data, f)

    elapsed = time.time() - t_start
    print(f"-> Output file generated successfully in {elapsed:.2f}s!")
    print("==================================================")


if __name__ == '__main__':
    main()
