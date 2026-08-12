/**
 * Stand-in for `next/cache` under the test runner.
 *
 * `next/cache` is one of Next's server entry points and does not resolve
 * outside a Next build — importing it from plain Node fails with
 * ERR_MODULE_NOT_FOUND. That is the whole reason a `'use server'` module could
 * not be *executed* in a test until now, only read as source.
 *
 * These are inert on purpose. A test that cares what was revalidated replaces
 * them with `mock.module('next/cache', …)`, which resolves through this file;
 * a test that does not care gets a no-op instead of a crash.
 */

export function revalidatePath() {}

export function revalidateTag() {}

export function unstable_noStore() {}
