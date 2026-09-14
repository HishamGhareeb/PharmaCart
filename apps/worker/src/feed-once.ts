import { createFeedSnapshotSink } from '../../../packages/db/src/feed-sink.ts';
import { createRuntimePool } from '../../../packages/db/src/runtime.ts';
import { containedFilesystemReader } from '../../../packages/transport-safety/src/path-boundary.ts';
import { loadFeedManifestFile, parseFeedOnceConfig } from './feed-once-config.ts';
import { filesystemFeedDirectory, runFeedPass, type FeedSnapshotSink } from './feed-worker.ts';

// One guarded, synthetic, local feed pass persisted through the transactional sink.
//   node --env-file=infra/runtime.env apps/worker/src/feed-once.ts --manifest <file> --root <drop directory>
// Exit 0: every file accepted or duplicate. Exit 1: the pass or a file was refused. Exit 2: invalid configuration.

const EXIT_REFUSED = 1;
const EXIT_INVALID_CONFIGURATION = 2;

const configuration = parseFeedOnceConfig(process.argv.slice(2), process.env);
if (configuration.kind === 'invalid') {
  process.stderr.write(`${JSON.stringify(configuration)}\n`);
  process.exitCode = EXIT_INVALID_CONFIGURATION;
} else {
  const { config } = configuration;
  const manifest = await loadFeedManifestFile(config.manifestPath);
  if (manifest.kind === 'rejected') {
    process.stderr.write(`${JSON.stringify(manifest)}\n`);
    process.exitCode = EXIT_INVALID_CONFIGURATION;
  } else {
    const pool = await createRuntimePool({ max: 2 });
    try {
      const sink: FeedSnapshotSink = createFeedSnapshotSink({
        pool,
        installationSubject: manifest.manifest.installationSubject,
        lockTimeoutMs: config.lockTimeoutMs,
      });
      const result = await runFeedPass({
        root: config.root,
        manifest: manifest.manifest,
        reader: containedFilesystemReader,
        directory: filesystemFeedDirectory,
        sink,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      const clean = result.kind === 'completed' && result.decisions.every((decision) => decision.kind !== 'rejected');
      if (!clean) process.exitCode = EXIT_REFUSED;
    } finally {
      await pool.end();
    }
  }
}
