import { clientBundle } from './scripts/dsh-client-preset.ts'

const PLUGIN_ID = 'dsh-turn-fork'
const clientConfig = clientBundle(PLUGIN_ID)

export default () => [
  {
    name: `${PLUGIN_ID}/host`,
    entry: { index: 'src/index.ts' },
    outDir: 'dist-host',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${PLUGIN_ID}/testing`,
    entry: { testing: 'src/testing.ts' },
    outDir: 'dist-testing',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  clientConfig,
]
