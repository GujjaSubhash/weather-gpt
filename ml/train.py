"""
Train the Hyderabad flood-risk classifier and export it for the web app.

WHAT THIS REPLACES
------------------
app/api/weather/route.ts used to decide flood risk like this:

    if (effectiveRain >= 7) return 'HIGH';
    if (effectiveRain >= 3) return 'MODERATE';
    return 'SAFE';

Two thresholds on one instantaneous number. It cannot tell 80 mm falling on dry
ground from 80 mm falling on ground that has already absorbed 67 mm over the
preceding four days — which is exactly the situation Hyderabad was in on
13 October 2020. This script learns that difference from 40 years of data.

METHOD
------
Features  : rainfall accumulations over 1h/3h/6h/24h/72h/7d, peak hourly burst,
            a 30-day antecedent precipitation index, and seasonality. Every one
            is computable at request time from a single Open-Meteo call, which
            is a hard constraint — a feature the app cannot obtain live is
            useless no matter how predictive it is offline.
Label     : GloFAS river discharge entering its top 2% within the next 48 hours.
            Deliberately NOT derived from rainfall; see ml/fetch_data.py.
Split     : chronological, never random. Random splitting on weather data leaks
            across the train/test boundary, because the hour before and the hour
            after a flood look nearly identical and would land on both sides.
              train 1985-2014 | validation 2015-2019 | test 2020-2024
            The October 2020 flood is therefore in the TEST set — the model has
            never seen it during fitting.
Models    : logistic regression (shipped) and gradient boosting (compared).
            Logistic ships because it exports to a dot product, so inference in
            the app needs no ML runtime at all, and because its coefficients let
            the UI say WHY a reading is elevated. If boosting won by a wide
            margin that trade would be worth revisiting; the metrics table in
            ml/metrics.json records whether it does.
Baseline  : the two thresholds above, scored on the same held-out years. A model
            that cannot beat the rule it replaces is not worth shipping.

Usage:
    python ml/train.py
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    precision_recall_fscore_support,
    roc_auc_score,
)
from sklearn.preprocessing import StandardScaler

HERE = Path(__file__).parent
DATA_DIR = HERE / "data"
RAIN_CSV = DATA_DIR / "hyderabad_hourly_rain.csv"
DISCHARGE_CSV = DATA_DIR / "hyderabad_daily_discharge.csv"

MODEL_JSON = HERE.parent / "lib" / "flood-model.json"
METRICS_JSON = HERE / "metrics.json"
FIXTURE_JSON = HERE / "parity_fixture.json"

# Sample a feature row every 6 hours. Hourly rows would be ~350k near-duplicates
# (consecutive hours share almost all of their trailing window) and would inflate
# the apparent sample size without adding information.
SAMPLE_STRIDE_HOURS = 6

# A "flood" is discharge unusually high FOR ITS OWN ERA, not against a fixed
# number. The record is strongly non-stationary — median flow at this point
# roughly doubled between the late 1990s and the 2020s, and days above a fixed
# 1990s p98 went from 0.5% to 9.5% of the year. Against a fixed threshold the
# model gets rewarded for the trend rather than for reading rainfall, which is
# both misleading and useless at request time. So the threshold is recomputed
# from a trailing baseline window and lagged by a day, which keeps the label
# meaning "high for this era" and keeps future information out of it.
DISCHARGE_PERCENTILE = 98.0
LABEL_BASELINE_DAYS = 3650      # ten-year trailing baseline
LABEL_BASELINE_MIN_DAYS = 1095  # need three years before a label is trustworthy

# The river responds to rain with a lag, so a feature row is positive if high
# flow arrives within this many days.
LABEL_HORIZON_DAYS = 2

# Antecedent precipitation index: sum of daily rain discounted by k^age. k=0.9 is
# the standard value in the urban-hydrology literature; it gives rain a ~7-day
# half-life, which is roughly how long soil stays saturated.
API_DECAY = 0.9
API_WINDOW_DAYS = 30

# GloFAS at this point begins in 1997, and a label needs LABEL_BASELINE_MIN_DAYS
# of history behind it before its threshold means anything — so the first usable
# label is 2000-01-01, not 1985. The rainfall archive reaches back to 1940, but
# rainfall without a label trains nothing.
TRAIN_YEARS = (2000, 2014)
VALID_YEARS = (2015, 2019)
TEST_YEARS = (2020, 2024)

# Rainfall only. Month-of-year was tried and dropped — see SEASONALITY below.
FEATURES = [
    "rain_1h",
    "rain_3h",
    "rain_6h",
    "rain_24h",
    "rain_72h",
    "rain_7d",
    "max_1h_in_24h",
    "wet_hours_24h",
    "api_30d",
]

# Seasonality is computed and evaluated as an ablation, but is NOT shipped by
# default. With month_sin/month_cos in the feature set they dominate every
# rainfall term, and the model degenerates into a calendar: it would call an
# elevated risk on a dry October afternoon purely because October is wet on
# average. That is worse than useless in a live app — the whole point is to
# react to what is actually falling. train.py reports both so the trade is
# visible in ml/metrics.json rather than asserted here.
SEASONAL_FEATURES = ["month_sin", "month_cos"]

# Human-readable reasons, used by the app to explain an elevated reading. Keyed
# by feature so lib/flood-risk.ts can name the top contributors without
# hardcoding a second copy of the feature list.
FEATURE_LABELS = {
    "rain_1h": "rainfall in the last hour",
    "rain_3h": "rainfall over 3 hours",
    "rain_6h": "rainfall over 6 hours",
    "rain_24h": "rainfall over 24 hours",
    "rain_72h": "rainfall over 3 days",
    "rain_7d": "rainfall over 7 days",
    "max_1h_in_24h": "peak hourly downpour",
    "wet_hours_24h": "hours of rain in the last day",
    "api_30d": "how saturated the ground already is",
    "month_sin": "time of year",
    "month_cos": "time of year",
}


def load_rain() -> pd.Series:
    df = pd.read_csv(RAIN_CSV, parse_dates=["time"])
    s = df.set_index("time")["precipitation_mm"].astype(float).fillna(0.0)
    s = s.sort_index()
    dupes = s.index.duplicated()
    if dupes.any():
        # DST-free timezone, so duplicates would signal a stitching bug in the
        # chunked download rather than a real ambiguity.
        print(f"  ! dropping {int(dupes.sum())} duplicate timestamps")
        s = s[~dupes]
    return s


def load_discharge() -> pd.Series:
    df = pd.read_csv(DISCHARGE_CSV, parse_dates=["date"])
    s = df.set_index("date")["river_discharge_m3s"].astype(float)
    return s.sort_index()


def build_features(rain: pd.Series) -> pd.DataFrame:
    """Trailing-window rainfall features, computed on the full hourly series."""
    feats = pd.DataFrame(index=rain.index)

    feats["rain_1h"] = rain
    feats["rain_3h"] = rain.rolling("3h").sum()
    feats["rain_6h"] = rain.rolling("6h").sum()
    feats["rain_24h"] = rain.rolling("24h").sum()
    feats["rain_72h"] = rain.rolling("72h").sum()
    feats["rain_7d"] = rain.rolling("168h").sum()
    feats["max_1h_in_24h"] = rain.rolling("24h").max()
    feats["wet_hours_24h"] = (rain > 0.1).rolling("24h").sum()

    # Antecedent precipitation index. Daily totals discounted by age, then
    # broadcast back onto the hourly index. Shifted by one day so "today's" rain
    # is not double-counted — it is already in rain_24h.
    daily = rain.resample("D").sum()
    weights = API_DECAY ** np.arange(API_WINDOW_DAYS)
    api = daily.shift(1).rolling(API_WINDOW_DAYS).apply(
        lambda w: float(np.dot(w[::-1], weights)), raw=True
    )
    feats["api_30d"] = api.reindex(feats.index, method="ffill")

    month = feats.index.month.to_numpy()
    feats["month_sin"] = np.sin(2 * np.pi * month / 12)
    feats["month_cos"] = np.cos(2 * np.pi * month / 12)

    return feats


def rolling_threshold(discharge: pd.Series) -> pd.Series:
    """
    Per-day high-flow threshold from a trailing baseline window.

    Shifted by one day so the threshold for day d is built only from days
    strictly before d. Without the shift the day being labelled would help set
    the bar it is measured against.
    """
    daily = discharge.asfreq("D") if discharge.index.freq else discharge.reindex(
        pd.date_range(discharge.index.min(), discharge.index.max(), freq="D")
    )
    return (
        daily.shift(1)
        .rolling(LABEL_BASELINE_DAYS, min_periods=LABEL_BASELINE_MIN_DAYS)
        .quantile(DISCHARGE_PERCENTILE / 100.0)
    )


def build_labels(discharge: pd.Series, index: pd.DatetimeIndex,
                 threshold: pd.Series) -> pd.Series:
    """1 when discharge clears its trailing threshold within the horizon."""
    full = pd.date_range(discharge.index.min(), discharge.index.max(), freq="D")
    daily = discharge.reindex(full)
    thr = threshold.reindex(full)

    high = (daily >= thr).astype(float)
    # Unknown wherever either side is missing, so those rows drop out entirely
    # instead of silently counting as "no flood".
    high[daily.isna() | thr.isna()] = np.nan

    # Forward-looking max: today or any of the next N days.
    window = high[::-1].rolling(LABEL_HORIZON_DAYS + 1, min_periods=1).max()[::-1]

    days = pd.DatetimeIndex(index.normalize())
    return pd.Series(window.reindex(days).to_numpy(), index=index)


def year_mask(index: pd.DatetimeIndex, span: tuple[int, int]) -> np.ndarray:
    years = index.year.to_numpy()
    return (years >= span[0]) & (years <= span[1])


def evaluate(name: str, y_true: np.ndarray, prob: np.ndarray, threshold: float) -> dict:
    pred = (prob >= threshold).astype(int)
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_true, pred, average="binary", zero_division=0
    )
    tn, fp, fn, tp = confusion_matrix(y_true, pred, labels=[0, 1]).ravel()
    return {
        "model": name,
        "threshold": round(float(threshold), 4),
        "precision": round(float(precision), 4),
        "recall": round(float(recall), 4),
        "f1": round(float(f1), 4),
        "roc_auc": round(float(roc_auc_score(y_true, prob)), 4),
        "pr_auc": round(float(average_precision_score(y_true, prob)), 4),
        "brier": round(float(brier_score_loss(y_true, prob)), 5),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def evaluate_rule(name: str, y_true: np.ndarray, rain_1h: np.ndarray, cutoff: float) -> dict:
    """Score the existing threshold rule as a binary classifier."""
    pred = (rain_1h >= cutoff).astype(int)
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_true, pred, average="binary", zero_division=0
    )
    tn, fp, fn, tp = confusion_matrix(y_true, pred, labels=[0, 1]).ravel()
    return {
        "model": name,
        "threshold": cutoff,
        "precision": round(float(precision), 4),
        "recall": round(float(recall), 4),
        "f1": round(float(f1), 4),
        "roc_auc": None,   # a fixed rule has no score to rank by
        "pr_auc": None,
        "brier": None,
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def pick_threshold_for_recall(y_true, prob, target_recall: float) -> float:
    """Lowest probability cutoff that still reaches the target recall."""
    order = np.argsort(prob)[::-1]
    sorted_true = y_true[order]
    sorted_prob = prob[order]
    total_pos = max(1, int(y_true.sum()))
    cum_tp = np.cumsum(sorted_true)
    hit = np.argmax((cum_tp / total_pos) >= target_recall)
    return float(sorted_prob[hit]) if (cum_tp / total_pos).max() >= target_recall else 0.05


def pick_threshold_best_f1(y_true, prob) -> float:
    candidates = np.quantile(prob, np.linspace(0.50, 0.999, 200))
    best_f1, best_t = -1.0, 0.5
    for t in np.unique(candidates):
        pred = (prob >= t).astype(int)
        _, _, f1, _ = precision_recall_fscore_support(
            y_true, pred, average="binary", zero_division=0
        )
        if f1 > best_f1:
            best_f1, best_t = f1, float(t)
    return best_t


def main() -> int:
    if not RAIN_CSV.exists() or not DISCHARGE_CSV.exists():
        print("Missing data. Run: python ml/fetch_data.py")
        return 1

    print("Loading data...")
    rain = load_rain()
    discharge = load_discharge()
    usable = discharge.dropna()
    print(f"  rain      {rain.index.min().date()} -> {rain.index.max().date()}  ({len(rain):,} hours)")
    print(f"  discharge {usable.index.min().date()} -> {usable.index.max().date()}  "
          f"({len(usable):,} days with a value, {len(discharge) - len(usable):,} missing)")

    # The non-stationarity that forces a trailing threshold. Reported here so the
    # reason for that design choice is visible in the run, not just in a comment.
    blocks = []
    for start in range(1995, 2025, 5):
        blk = usable[(usable.index.year >= start) & (usable.index.year <= start + 4)]
        if len(blk):
            blocks.append({"period": f"{start}-{start + 4}",
                           "medianFlowM3s": round(float(blk.median()), 2),
                           "p99FlowM3s": round(float(blk.quantile(0.99)), 1)})
    print("  discharge trend (why the label threshold is trailing, not fixed):")
    for b in blocks:
        print(f"    {b['period']}  median {b['medianFlowM3s']:>6.2f}   p99 {b['p99FlowM3s']:>7.1f}")

    print("Building features...")
    feats_all = build_features(rain)
    feats_all = feats_all.iloc[::SAMPLE_STRIDE_HOURS].dropna()

    thresholds = rolling_threshold(discharge)
    labels = build_labels(discharge, feats_all.index, thresholds)
    keep = labels.notna()
    feats_all, labels = feats_all[keep], labels[keep]

    y = labels.to_numpy(dtype=int)
    idx = feats_all.index

    tr = year_mask(idx, TRAIN_YEARS)
    va = year_mask(idx, VALID_YEARS)
    te = year_mask(idx, TEST_YEARS)

    print(f"  samples: train {tr.sum():,} | valid {va.sum():,} | test {te.sum():,}")
    print(f"  positive rate: train {y[tr].mean():.3%} | valid {y[va].mean():.3%} | test {y[te].mean():.3%}")

    if y[te].sum() == 0 or y[tr].sum() == 0:
        print("! Not enough positive labels to evaluate honestly.")
        return 1

    # ── Ablation: does month-of-year earn its place? ──────────────────────────
    print("\nAblation (does seasonality earn its place?)")
    ablation = []
    fitted: dict[str, tuple] = {}
    for name, cols in (("rainfall only", FEATURES),
                       ("rainfall + seasonality", FEATURES + SEASONAL_FEATURES)):
        Xa = feats_all[cols].to_numpy(dtype=float)
        sc = StandardScaler().fit(Xa[tr])
        Xs = sc.transform(Xa)
        m = LogisticRegression(max_iter=2000, class_weight="balanced", C=1.0,
                               solver="lbfgs").fit(Xs[tr], y[tr])
        pv, pt = m.predict_proba(Xs[va])[:, 1], m.predict_proba(Xs[te])[:, 1]
        t = pick_threshold_best_f1(y[va], pv)
        row = evaluate(name, y[te], pt, t)
        top = max(zip(cols, m.coef_[0]), key=lambda kv: abs(kv[1]))
        row["topFeature"] = f"{top[0]} ({top[1]:+.3f})"
        ablation.append(row)
        fitted[name] = (sc, m, pv, pt, t, cols)
        print(f"  {name:<24} PR-AUC {row['pr_auc']:.3f}  F1 {row['f1']:.3f}  "
              f"top feature: {row['topFeature']}")

    # Ship rainfall-only: it is the honest model for a live app, and the ablation
    # above records what that choice costs.
    scaler, logit, p_va, p_te, _, ship_cols = fitted["rainfall only"]
    X = feats_all[ship_cols].to_numpy(dtype=float)
    Xs = scaler.transform(X)

    boost = HistGradientBoostingClassifier(
        max_iter=300, learning_rate=0.06, max_depth=6,
        class_weight="balanced", random_state=42,
    ).fit(X[tr], y[tr])
    b_te = boost.predict_proba(X[te])[:, 1]

    # Operating points chosen on VALIDATION, then reported on TEST.
    # HIGH favours precision (best F1); MODERATE favours recall, matching the
    # app's existing flood-cautious stance that risk may be overstated but not
    # understated.
    t_high = pick_threshold_best_f1(y[va], p_va)
    t_moderate = min(t_high, pick_threshold_for_recall(y[va], p_va, 0.90))
    print(f"  thresholds  moderate >= {t_moderate:.3f}   high >= {t_high:.3f}")

    rain_1h_te = feats_all["rain_1h"].to_numpy()[te]
    results = [
        evaluate("logistic_regression (shipped) @HIGH", y[te], p_te, t_high),
        evaluate("logistic_regression (shipped) @MODERATE", y[te], p_te, t_moderate),
        evaluate("gradient_boosting (comparison)", y[te], b_te, t_high),
        evaluate_rule("baseline rule: rain >= 7 mm/h (HIGH)", y[te], rain_1h_te, 7.0),
        evaluate_rule("baseline rule: rain >= 3 mm/h (MODERATE)", y[te], rain_1h_te, 3.0),
    ]

    print(f"\n  Held-out test years {TEST_YEARS[0]}-{TEST_YEARS[1]}")
    print(f"  {'model':<44} {'prec':>6} {'recall':>7} {'F1':>6} {'PR-AUC':>7}")
    for r in results:
        pr = f"{r['pr_auc']:.3f}" if r["pr_auc"] is not None else "  -  "
        print(f"  {r['model']:<44} {r['precision']:>6.3f} {r['recall']:>7.3f} "
              f"{r['f1']:>6.3f} {pr:>7}")

    # ── Export ────────────────────────────────────────────────────────────────
    coefs = logit.coef_[0]
    payload = {
        "schemaVersion": 1,
        "modelVersion": "1.0.0",
        "trainedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "kind": "logistic_regression",
        "note": (
            "Standardize each feature with (x - mean) / scale, dot with coefficients, "
            "add intercept, apply the logistic function. No ML runtime required."
        ),
        "features": list(ship_cols),
        "featureLabels": {f: FEATURE_LABELS[f] for f in ship_cols},
        "mean": [round(float(v), 6) for v in scaler.mean_],
        "scale": [round(float(v), 6) for v in scaler.scale_],
        "coefficients": [round(float(v), 6) for v in coefs],
        "intercept": round(float(logit.intercept_[0]), 6),
        "thresholds": {
            "moderate": round(float(t_moderate), 4),
            "high": round(float(t_high), 4),
        },
        "training": {
            "location": {"latitude": 17.385, "longitude": 78.4867},
            "trainYears": list(TRAIN_YEARS),
            "validYears": list(VALID_YEARS),
            "testYears": list(TEST_YEARS),
            "sampleStrideHours": SAMPLE_STRIDE_HOURS,
            "labelDefinition": (
                f"GloFAS river discharge >= its own trailing "
                f"p{DISCHARGE_PERCENTILE:g} (over the previous "
                f"{LABEL_BASELINE_DAYS // 365} years, lagged one day) "
                f"within {LABEL_HORIZON_DAYS} days"
            ),
            "apiDecay": API_DECAY,
            "apiWindowDays": API_WINDOW_DAYS,
        },
        "testMetrics": {
            "prAuc": results[0]["pr_auc"],
            "rocAuc": results[0]["roc_auc"],
            "highPrecision": results[0]["precision"],
            "highRecall": results[0]["recall"],
        },
    }

    # A handful of real held-out rows, so the TypeScript port can prove it
    # reproduces these probabilities rather than being trusted on inspection.
    rng = np.random.default_rng(7)
    te_pos = np.flatnonzero(te)
    pick = rng.choice(te_pos, size=min(12, te_pos.size), replace=False)
    pick = np.unique(np.concatenate([pick, te_pos[np.argsort(p_te)[-3:]]]))
    payload["testVectors"] = [
        {
            "at": idx[i].strftime("%Y-%m-%dT%H:%M"),
            "features": {f: round(float(feats_all[f].to_numpy()[i]), 6) for f in ship_cols},
            "expectedProbability": round(
                float(logit.predict_proba(scaler.transform(X[i:i + 1]))[0, 1]), 9
            ),
        }
        for i in pick
    ]

    MODEL_JSON.parent.mkdir(parents=True, exist_ok=True)
    MODEL_JSON.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"\n  wrote {MODEL_JSON.relative_to(HERE.parent)}")

    # ── Parity fixture ────────────────────────────────────────────────────────
    # The test vectors above prove the TypeScript port does the ARITHMETIC right.
    # They do not prove it builds the FEATURES right, which is the easier thing
    # to get wrong: a rolling window off by one hour, or an antecedent index that
    # forgets to exclude the current day, produces no error at all — just a
    # quietly worse model. So each fixture row carries the raw hourly rainfall
    # the app would have fetched, and lets the port recompute the features from
    # scratch and be checked against pandas.
    #
    # This lives in ml/ rather than lib/ because it is a test artifact; only
    # flood-model.json is bundled into the app.
    fixture_rows = []
    hours_needed = (API_WINDOW_DAYS + 1) * 24
    for i in pick[:6]:
        end = idx[i]
        window = rain.loc[:end].iloc[-hours_needed:]
        if len(window) < hours_needed:
            continue
        fixture_rows.append({
            "at": end.strftime("%Y-%m-%dT%H:%M"),
            "series": {
                "time": [t.strftime("%Y-%m-%dT%H:%M") for t in window.index],
                "precipitation": [round(float(v), 4) for v in window.to_numpy()],
            },
            "expectedFeatures": {
                f: round(float(feats_all[f].to_numpy()[i]), 6) for f in ship_cols
            },
            "expectedProbability": round(
                float(logit.predict_proba(scaler.transform(X[i:i + 1]))[0, 1]), 9
            ),
        })

    FIXTURE_JSON.write_text(json.dumps({
        "modelVersion": payload["modelVersion"],
        "note": "Raw hourly rainfall windows + the features pandas derived from them.",
        "cases": fixture_rows,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"  wrote {FIXTURE_JSON.relative_to(HERE.parent)} ({len(fixture_rows)} cases)")

    coef_table = sorted(
        ({"feature": f, "coefficient": round(float(c), 4)} for f, c in zip(ship_cols, coefs)),
        key=lambda r: abs(r["coefficient"]), reverse=True,
    )
    METRICS_JSON.write_text(json.dumps({
        "generatedAt": payload["trainedAt"],
        "modelVersion": payload["modelVersion"],
        "split": {
            "train": f"{TRAIN_YEARS[0]}-{TRAIN_YEARS[1]}",
            "validation": f"{VALID_YEARS[0]}-{VALID_YEARS[1]}",
            "test": f"{TEST_YEARS[0]}-{TEST_YEARS[1]}",
        },
        "samples": {
            "train": int(tr.sum()), "validation": int(va.sum()), "test": int(te.sum()),
            "trainPositiveRate": round(float(y[tr].mean()), 5),
            "testPositiveRate": round(float(y[te].mean()), 5),
        },
        "labelDefinition": payload["training"]["labelDefinition"],
        "dischargeTrend": blocks,
        "results": results,
        "ablation": ablation,
        "coefficients": coef_table,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"  wrote {METRICS_JSON.relative_to(HERE.parent)}")

    print("\n  Top coefficients (standardized):")
    for row in coef_table[:6]:
        print(f"    {row['feature']:<16} {row['coefficient']:+.4f}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
