import esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions[]} */
const buildConfigs = [
  {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: !isProduction,
    minify: isProduction,
    logLevel: 'info',
  },
  {
    entryPoints: ['src/security.ts', 'src/pairingController.ts', 'src/localBridge.ts'],
    bundle: true,
    outdir: 'dist/lib',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    logLevel: 'error',
  },
];

async function run() {
  if (isWatch) {
    const ctx = await esbuild.context(buildConfigs[0]);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    for (const cfg of buildConfigs) {
      await esbuild.build(cfg);
    }
    console.log('Build completed successfully.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
