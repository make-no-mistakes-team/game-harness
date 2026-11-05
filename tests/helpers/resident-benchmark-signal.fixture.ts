import { mock } from 'bun:test';
import * as filesystem from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { ResidentBenchmarkSlotOptions } from '../../scripts/native-resident-benchmark-slot.ts';

// This wrapper exists only in this dedicated subprocess. Every filesystem
// operation delegates to the real implementation; no native owner is replaced.
const [mode, optionsJson] = process.argv.slice(2);
if (mode !== 'manifest-read' && mode !== 'raw-timings-rename' && mode !== 'final-result-rename') throw new Error('Unknown resident signal fixture mode');
if (!optionsJson || !process.send) throw new Error('Missing resident signal fixture options or owned IPC');
const options: ResidentBenchmarkSlotOptions = JSON.parse(optionsJson);
const manifestPath = resolve(options.project, options.manifestPath);
const reportDirectory = resolve(options.reportDirectory);
const rawPath = join(reportDirectory, 'raw-timings.json');
const resultPath = join(reportDirectory, 'platform-result.json');
const actual = { ...filesystem };
const gate = Promise.withResolvers<void>();
let held = false, released = false, lastRenamed: string | null = null;
const send = (value: Record<string, unknown>) => { process.send!({ fixture: 'resident-benchmark-signal', ...value }); };
const onMessage = (value: unknown) => {
  if (value === 'check-held') send({ event: 'held', held, released });
  if (value === 'release') { released = true; gate.resolve(); }
};
const onDisconnect = () => { released = true; gate.resolve(); };
process.on('message', onMessage);
process.once('disconnect', onDisconnect);
async function hold(seam: string) {
  if (held) return;
  held = true;
  send({ event: 'ready', seam });
  await gate.promise;
  send({ event: 'released', seam });
}
mock.module('node:fs/promises', () => ({
  ...actual,
  readFile: async (...args: Parameters<typeof filesystem.readFile>) => {
    if (mode === 'manifest-read' && String(args[0]) === manifestPath) await hold('manifest-read');
    return await actual.readFile(...args);
  },
  rename: async (...args: Parameters<typeof filesystem.rename>) => {
    if (mode === 'raw-timings-rename' && String(args[1]) === rawPath) await hold('raw-timings-rename');
    if (mode === 'final-result-rename' && String(args[1]) === resultPath) await hold('final-result-rename');
    await actual.rename(...args);
    if (String(args[1]) === join(reportDirectory, basename(String(args[1])))) lastRenamed = basename(String(args[1]));
  },
  open: async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await actual.open(...args);
    if (String(args[0]) === reportDirectory) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        // atomicJson has already synced and closed the actual temporary file,
        // renamed it, and now synced its directory. Observe, never replace it.
        send({ event: 'durable', file: lastRenamed });
      };
    }
    return handle;
  },
}));

// Deliberately load the real slot and its real SDK graph after the scoped fs
// seam. The observer only reports signal receipt: returning a slot promise here
// would accidentally repair the shutdown coordination that this fixture tests.
const { runResidentBenchmarkSlot } = await import('../../scripts/native-resident-benchmark-slot.ts');
const postmortem = await import('@oh-my-pi/pi-utils/postmortem');
const unregister = postmortem.register('resident-benchmark-signal-observer', reason => {
  if (reason === postmortem.Reason.SIGINT || reason === postmortem.Reason.SIGTERM) send({ event: 'sdk-signal', reason });
}, { exitOnly: true });
try {
  await runResidentBenchmarkSlot(options);
} finally {
  gate.resolve();
  unregister();
  process.removeListener('message', onMessage);
  process.removeListener('disconnect', onDisconnect);
  if (process.connected) process.disconnect?.();
}
