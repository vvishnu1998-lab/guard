/**
 * test-s3-object-buffer.ts — getS3ObjectBuffer (services/s3.ts) against a fake
 * GetObject client. No network, no credentials, no bucket.
 *
 *   npx ts-node -P tsconfig.scripts.json scripts/test-s3-object-buffer.ts   (from apps/api)
 */
process.env.S3_BUCKET = 'test-bucket';
process.env.AWS_REGION = 'us-east-1';

let failures = 0;
let passes = 0;

// A harness that stops before its last check must not pass: an await that never
// settles drains the event loop, and Node would then exit 0 having printed nothing.
let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.log('  ✗ FAIL: the harness stopped before its last check (a promise never settled)');
    process.exitCode = 1;
  }
});
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}

interface FakeCall { params: Record<string, unknown>; aborted: boolean }

/** A client whose request resolves with `body`, rejects with `error`, or hangs until aborted. */
function fakeClient(outcome: { body?: unknown; error?: Record<string, unknown>; hang?: boolean }) {
  const calls: FakeCall[] = [];
  const client = {
    getObject(params: Record<string, unknown>) {
      const call: FakeCall = { params, aborted: false };
      calls.push(call);
      let rejectFn: (e: unknown) => void = () => undefined;
      const p = new Promise((resolve, reject) => {
        rejectFn = reject;
        if (outcome.hang) return;
        if (outcome.error) reject(Object.assign(new Error(String(outcome.error.code)), outcome.error));
        else resolve({ Body: outcome.body });
      });
      return {
        promise: () => p,
        abort: () => { call.aborted = true; rejectFn(Object.assign(new Error('Request aborted by user'), { code: 'RequestAbortedError' })); },
      };
    },
  };
  return { client: client as never, calls };
}

async function main(): Promise<void> {
  const { getS3ObjectBuffer, S3ObjectTooLargeError } = await import('../src/services/s3');
  const MAX = 2 * 1024 * 1024;
  const opts = { maxBytes: MAX, timeoutMs: 300 };

  {
    const body = Buffer.from('logo bytes');
    const f = fakeClient({ body });
    const got = await getS3ObjectBuffer('company-logos/x/y.png', opts, f.client);
    check(got.equals(body), 'S1 returns the object bytes');
    check(f.calls.length === 1 && f.calls[0].params.Bucket === 'test-bucket' && f.calls[0].params.Key === 'company-logos/x/y.png',
      `S1 one GetObject on the configured bucket and key (got ${JSON.stringify(f.calls.map((c) => c.params))})`);
    check(f.calls[0].params.Range === `bytes=0-${MAX}`, `S1 the request itself is capped: Range bytes=0-${MAX}, one byte past the limit (got ${f.calls[0].params.Range})`);
  }
  {
    const f = fakeClient({ body: Buffer.alloc(MAX) });
    const got = await getS3ObjectBuffer('k', opts, f.client);
    check(got.length === MAX, 'S2 exactly maxBytes: accepted');
    const g = fakeClient({ body: Buffer.alloc(MAX + 1) });
    let err: unknown = null;
    try { await getS3ObjectBuffer('k', opts, g.client); } catch (e) { err = e; }
    check(err instanceof S3ObjectTooLargeError, `S2 maxBytes + 1: S3ObjectTooLargeError, not a truncated buffer (got ${String(err)})`);
  }
  {
    const f = fakeClient({ body: new Uint8Array([1, 2, 3]) });
    const got = await getS3ObjectBuffer('k', opts, f.client);
    check(Buffer.isBuffer(got) && got.length === 3, 'S3 a Uint8Array body comes back as a Buffer');
  }
  {
    const f = fakeClient({ hang: true });
    const t0 = Date.now();
    let err: any = null;
    try { await getS3ObjectBuffer('k', opts, f.client); } catch (e) { err = e; }
    const took = Date.now() - t0;
    check(f.calls[0]?.aborted === true && err?.code === 'RequestAbortedError' && took >= 280 && took < 2000,
      `S4 a request that never answers is aborted at timeoutMs and rejects with RequestAbortedError (aborted ${f.calls[0]?.aborted}, ${err?.code}, ${took} ms)`);
  }
  {
    const f = fakeClient({ error: { code: 'NoSuchKey', statusCode: 404 } });
    let err: any = null;
    try { await getS3ObjectBuffer('k', opts, f.client); } catch (e) { err = e; }
    check(err?.code === 'NoSuchKey', `S5 an S3 error passes through with its code (got ${err?.code})`);
  }
  {
    const f = fakeClient({ body: Buffer.from('x') });
    await getS3ObjectBuffer('k', opts, f.client);
    await new Promise((r) => setTimeout(r, 400));
    check(f.calls[0].aborted === false, 'S6 after a success the timer is cleared: nothing aborts the finished request later');
  }
  {
    const f = fakeClient({ body: undefined });
    let err: unknown = null;
    try { await getS3ObjectBuffer('k', opts, f.client); } catch (e) { err = e; }
    check(err instanceof Error && /no buffered body/.test((err as Error).message), 'S7 no body: an error, never an empty logo');
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exit(1);
});
