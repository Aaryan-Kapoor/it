#!/usr/bin/env python3
"""Summarize complete benchmark files without importing or running the benchmarks."""
import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def quantile(values, probability):
    position = (len(values) - 1) * probability
    lower, upper = math.floor(position), math.ceil(position)
    return values[lower] + (values[upper] - values[lower]) * (position - lower)


def summary(values):
    if not values:
        return {"n": 0}
    if not all(finite(value) for value in values):
        raise ValueError("A metric contains a missing or non-finite value.")
    values = sorted(values)
    q25, q75 = quantile(values, .25), quantile(values, .75)
    return {"n": len(values), "median": statistics.median(values),
            "p25": q25, "p75": q75, "iqr": q75 - q25,
            "min": values[0], "max": values[-1]}


def span(values):
    result = summary(values)
    return {key: result[key] for key in ("n", "min", "max") if key in result}


def cpu_delta(before, after):
    # Linux includes guest and guest_nice in user and nice. Do not count them twice.
    if len(before) < 8 or len(after) < 8:
        raise ValueError("A CPU sample has fewer than eight counters.")
    delta = [after[i] - before[i] for i in range(8)]
    total = sum(delta)
    if any(value < 0 for value in delta) or total <= 0:
        raise ValueError("CPU counters reset or did not advance.")
    busy = total - delta[3] - delta[4]
    return busy, total


def collect_hot(hot, expected_count, metrics, timing, warnings, round_number):
    expected_warmup = 0 if expected_count == 1 else 1
    if hot["iterations"] != expected_count or hot["warmup"] != expected_warmup:
        raise ValueError("A hot backend block has unexpected iteration or warmup settings.")
    operations = hot["measurements"]
    expected_operations = {"artifacts:list", "artifact_with_history", "artifact_without_history",
                           "state:get", "delivery:waitingFor", "state:patch"}
    if len(operations) != 6 or {op["operation"] for op in operations} != expected_operations:
        raise ValueError("The hot backend operation set is incomplete.")
    for operation in operations:
        name = operation["operation"]
        samples = operation["wallSamplesMs"]
        if len(samples) != expected_count:
            raise ValueError("A hot backend block has an unexpected sample count.")
        metrics[f"hot.{name}.wallMs"].extend(samples)
        server = operation["server"]
        entry = timing.setdefault(name, {"availableBlocks": 0, "unavailableBlocks": 0,
            "matched": 0, "unmatched": 0, "requestIdMatches": 0, "timeWindowMatches": 0,
            "unknownCacheEntries": 0, "failed": 0, "retryEntries": 0,
            "cached": 0, "uncached": 0, "unknown": 0})
        if not server["available"]:
            entry["unavailableBlocks"] += 1
            warnings.append(f"Round {round_number} has no server timing for {name}.")
            continue
        entry["availableBlocks"] += 1
        for key in ("matched", "unmatched", "requestIdMatches", "timeWindowMatches",
                    "unknownCacheEntries", "failed", "retryEntries"):
            entry[key] += server[key]
        paired = server["samples"]
        actual = [sample for sample in paired if sample is not None]
        if len(paired) != expected_count or len(actual) != server["matched"] or server["matched"] + server["unmatched"] != expected_count:
            raise ValueError("Backend timing match counts disagree with the samples.")
        if server["requestIdMatches"] + server["timeWindowMatches"] != server["matched"]:
            raise ValueError("Backend timing association counts disagree.")
        if server["failed"]:
            warnings.append(f"Round {round_number} has failed matched executions for {name}.")
        for sample in actual:
            cache = "cached" if sample["cached"] is True else "uncached" if sample["cached"] is False else "unknown"
            entry[cache] += 1
            metrics[f"server.{name}.executionMs"].append(sample["executionMs"])
            if not server["failed"]:
                metrics[f"server.{name}.{cache}ExecutionMs"].append(sample["executionMs"])
        if server["unmatched"]:
            warnings.append(f"Round {round_number} has unmatched server timings for {name}.")


def summarize_file(path):
    rounds = {"compare.json": 6, "cold.json": 5, "click-compare.json": 2, "fresh-backend.json": 5}
    if path.name not in rounds:
        raise ValueError("Use compare.json, cold.json, click-compare.json, or fresh-backend.json.")
    data = json.loads(path.read_text())
    rows = data["rows"]
    expected = [(r, label) for r in range(rounds[path.name])
                for label in (["baseline", "candidate"] if r % 2 == 0 else ["candidate", "baseline"])]
    if [(row.get("round"), row.get("label")) for row in rows] != expected:
        raise ValueError(f"{path.name} is incomplete or has an unexpected block order.")
    result = {}
    for label in ("baseline", "candidate"):
        selected = [row for row in rows if row["label"] == label]
        metrics, timing = defaultdict(list), {}
        loads, disk, busy_blocks, busy_intervals = [], [], [], []
        total_busy = total_ticks = 0
        warnings = []
        for row in selected:
            if path.name == "compare.json":
                metrics["startMs"].append(row["startMs"])
                for mode in ("local", "network"):
                    for key in ("loadMs", "domContentMs", "gridVisibleMs", "gridInteractiveMs", "openMs"):
                        metrics[f"{mode}.{key}"].append(row[mode][key])
                for key in ("publish", "open", "actions", "waitTimeout", "waitReady"):
                    samples = row["cli"][key]
                    if len(samples) != 2:
                        raise ValueError("A CLI block does not contain two samples.")
                    metrics[f"cli.{key}Ms"].extend(samples)
                for process in ("service", "backend"):
                    for key in ("rssMiB", "pssMiB"):
                        metrics[f"memory.{process}.{key}"].append(row["memory"][process][key])
                hosts = row["host"]
                if len(hosts) < 2:
                    raise ValueError("A comparison block lacks host samples.")
                loads.extend(sample["load"] for sample in hosts)
                disk.extend(sample["freeGiB"] for sample in hosts)
                busy, total = cpu_delta(hosts[0]["cpu"], hosts[-1]["cpu"])
                total_busy += busy
                total_ticks += total
                busy_blocks.append(100 * busy / total)
                for before, after in zip(hosts, hosts[1:]):
                    try:
                        busy, total = cpu_delta(before["cpu"], after["cpu"])
                    except ValueError:
                        warnings.append(f"Round {row['round']} contains an unusable CPU interval.")
                    else:
                        busy_intervals.append(100 * busy / total)
                probe = row["probe"]["samplesMs"]
                if len(probe) != 5:
                    raise ValueError("A connector probe block does not contain five samples.")
                metrics["connectorProbeMs"].extend(probe)
                collect_hot(row["hot"], 5, metrics, timing, warnings, row["round"])
            else:
                loads.extend([row["loadBefore"], row["loadAfter"]])
                if path.name == "cold.json":
                    for key in ("freshSetupMs", "firstServeMs"):
                        metrics[key].append(row[key])
                elif path.name == "fresh-backend.json":
                    collect_hot(row["hot"], 1, metrics, timing, warnings, row["round"])
                else:
                    samples = row["clicks"]["rows"]
                    if len(samples) != 5:
                        raise ValueError("A click block does not contain five retained samples.")
                    metrics["frameClockUncertaintyMs"].append(row["clicks"]["frameClockUncertaintyMs"])
                    for sample in samples:
                        for key in ("clickToDeliveryMs", "commandToDeliveryMs", "deliveringPollMs", "ackRequestMs"):
                            metrics[key].append(sample[key])
        variant = {"blocks": len(selected), "metrics": {key: summary(values) for key, values in metrics.items()},
                   "load": {f"{minutes}Minute": span([sample[index] for sample in loads])
                            for index, minutes in enumerate((1, 5, 15))}, "warnings": warnings}
        if path.name == "compare.json":
            variant.update({"freeGiB": span(disk), "serverMatches": timing,
                "cpuBusy": {"weightedPercent": 100 * total_busy / total_ticks,
                            "blockPercent": summary(busy_blocks), "intervalPercent": span(busy_intervals)}})
        else:
            variant["cpuBusy"] = None
        if path.name == "fresh-backend.json":
            variant["serverMatches"] = timing
        result[label] = variant
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", type=Path, nargs="+", help="Completed comparison JSON files.")
    args = parser.parse_args()
    try:
        output = {path.name: summarize_file(path) for path in args.files}
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        parser.exit(1, f"Cannot summarize the inputs: {error}\n")
    print(json.dumps(output, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
