# Rust kernel implementation guide

Read only the sections relevant to the measured bottleneck. Verify APIs against the target project's Rust version and architecture.

## Measurement and code generation

Use existing benchmark and profiling infrastructure first. Keep inputs and compiler/profile settings comparable, consume outputs so the benchmark cannot disappear, and move unrelated setup out of the timed region. `std::hint::black_box` is useful where available, but does not make a benchmark representative on its own. Distinguish warm-cache and cold-cache behavior, account for noise and CPU frequency changes, and report repeated measurements rather than one favorable sample.

Inspect generated code using an existing disassembler or assembly tool. Cargo/rustc can also emit assembly for the appropriate target; choose the actual package, target, and feature arguments from the project rather than copying guessed commands. Look for vectorization, bounds checks, copies, spills, branches, and excessive code size. Check release-profile settings before considering LTO, codegen-unit, or target-feature experiments. Keep experimental build flags scoped to measurement unless a project-wide change is explicitly justified.

Sources: [Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html), [rustc code generation options](https://doc.rust-lang.org/rustc/codegen-options/index.html).

## SIMD and intrinsics

Use the target-specific `core::arch` or `std::arch` APIs supported by the toolchain. Guard architecture-specific imports and kernels with `cfg`. Only invoke feature-enabled kernels when the feature requirements are satisfied; use runtime feature detection when available or an explicit platform contract for `no_std`/embedded deployments. Detect outside the inner loop and keep a portable fallback for supported machines without that feature.

Handle full vector chunks and a bounded scalar tail. Unaligned load intrinsics remove an alignment requirement, not the need for every byte read to be valid and in bounds. Do not read beyond a slice merely because the memory is likely mapped. Test lengths around vector widths, zero-length slices, and permitted misalignment. Preserve signedness, overflow, NaN handling, and rounding requirements; vectorized reductions may change floating-point results.

Source: [architecture intrinsics and feature detection](https://doc.rust-lang.org/core/arch/).

## Inline assembly within Rust

Use a small `asm!` block for a demonstrated requirement. Check the official reference for the specific architecture, register classes, and toolchain. Prefer intrinsics when they expose the operation and let the compiler optimize across it.

Declare all inputs, outputs, register clobbers, and applicable ABI clobbers. Distinguish `out` from `lateout`: reuse of an input register is valid only when the instruction sequence no longer needs its old value. Restore any stack state you change, respect ABI alignment, and avoid hidden calls or undeclared memory effects.

Options such as `pure`, `nomem`, `readonly`, `nostack`, and `preserves_flags` are promises to the compiler, not performance hints. Specify them only when the entire block satisfies their documented contract. Model actual memory effects; inline assembly is not a substitute for Rust's atomic synchronization. Do not introduce `global_asm!` or naked functions for routine loop optimization; use them only for an actual entry-point or ABI requirement.

Source: [Rust inline assembly reference](https://doc.rust-lang.org/reference/inline-assembly.html).

## Raw memory and validation

Keep pointer arithmetic inside the valid allocation and respect alignment, initialization, reference validity, and aliasing requirements. Avoid fabricated references to packed or uninitialized data. Use explicit wrapping arithmetic when wrapping is part of the established behavior, rather than allowing a change in build profile to determine the result.

Validate against a straightforward reference and preserve regression coverage for each safety boundary. Miri can catch many classes of undefined behavior, but cannot interpret general inline assembly and has limits on supported architecture intrinsics. Test supported wrappers/fallbacks under Miri and validate machine-specific kernels natively on their actual targets; a successful fallback run does not prove assembly correctness. Cross-compilation verifies build compatibility, not runtime behavior or performance.

Sources: [undefined behavior in Rust](https://doc.rust-lang.org/reference/behavior-considered-undefined.html), [Miri capabilities and limitations](https://github.com/rust-lang/miri).
