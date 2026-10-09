---
name: rust-low-level-performance
description: Profile and optimize CPU-bound Rust hotspots using data layout, SIMD, architecture intrinsics, or inline assembly inside Rust. Use for measured low-level bottlenecks or explicit hardware constraints, rather than routine Rust development or speculative micro-optimization.
---

# Rust Low-Level Performance

Optimize a small, justified Rust kernel while preserving its behavior, safety contract, and supported hardware. Handwritten assembly is a tool, not a required outcome.

## When to use

Use this skill when profiling identifies a CPU or memory-access hotspot, or the task specifies a concrete hardware instruction, ABI, embedded constraint, or latency/throughput budget. Typical candidates are parsers, codecs, numerical loops, hashing, and packet-processing kernels.

For ordinary application development, ownership fixes, UI work, or latency dominated by network, disk, or database waits, prefer the general Rust skills. If a request merely says “make it faster” and has no evidence, start with measurement and a hypothesis. Do not introduce `unsafe`, SIMD, or assembly before establishing a reason. Hardware-specific correctness work may require low-level code without a speed claim; explain that distinction.

## Establish the baseline

- Inspect Cargo manifests, toolchain/MSRV, target triples, feature flags, existing benchmarks, deployment CPUs, and the current implementation. Stay within the authorized task; selecting this skill does not authorize changing deployment settings or installing tools.
- Identify the required metric, realistic input sizes and distributions, and behavior that must remain identical. Measure an optimized build using the project's existing tooling. Record compiler, target/CPU, profile, flags, and baseline results.
- Determine whether the limiting factor is computation, allocation, bandwidth, cache locality, branch behavior, synchronization, or external I/O. Read the generated assembly for the relevant kernel before assuming LLVM failed to optimize it.

## Choose the least complex effective change

Try algorithms, fewer allocations/copies, contiguous data, batching, and bounds-check-friendly safe loops first. Measure layout changes, vectorization, inlining, unrolling, and prefetching instead of applying them everywhere. Do not infer improvement from instruction count alone.

Use architecture intrinsics when the measured kernel benefits and the supported CPUs are known. Use `core::arch::asm!` only for a specific code-generation gap or hardware requirement that safe Rust or intrinsics cannot adequately express. Keep these implementations inside narrowly scoped Rust modules with an ordinary callable interface.

Read [references/kernel-guide.md](references/kernel-guide.md) when working on SIMD, raw memory, inline assembly, or benchmark methodology. It contains the implementation constraints and links to official sources. Verify exact API stability and target support against the project's toolchain; do not require nightly or raise MSRV just because a newer API exists.

## Preserve correctness and portability

Keep a portable reference implementation where applicable. Isolate architecture paths with `cfg` and CPU-feature dispatch or an explicitly documented deployment guarantee. Do not enable `target-cpu=native` globally for binaries intended for other machines.

Document each unsafe operation's actual invariants: valid pointers, bounds, initialization, alignment, lifetimes, aliasing, and CPU capabilities as applicable. A safe wrapper must enforce all caller-dependent conditions. Do not replace atomics with volatile memory access or weaken ordering without a concurrency argument. Do not use undefined behavior, change overflow or floating-point semantics silently, or make cryptographic constant-time behavior depend on unreviewed branches.

## Validate and stop

Compare optimized and reference paths on ordinary, empty, short, tail, boundary, and misaligned inputs where permitted, plus randomized cases. Exercise both dispatch and fallback paths. Use available Miri, sanitizers, or concurrency tools for relevant code; report unsupported paths rather than treating a skipped check as proof.

Benchmark repeated optimized-build runs on representative workloads, include dispatch overhead, and check the application-level metric as well as the isolated kernel. If a change produces no repeatable relevant benefit, remove it unless a concrete hardware requirement independently justifies it. Stop escalating to more complex techniques once the target is met; if measurement is unavailable, report the limitation and avoid claiming a speedup.

Deliver the change with before/after measurements, environment and inputs, correctness checks, hardware requirements and fallback behavior, and the reason the added complexity is justified. State any untested target or validation limit.
