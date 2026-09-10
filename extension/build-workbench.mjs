// Optional Storybook proof bundle. Uses the same installed Solid compiler as production.
import babel from '@rollup/plugin-babel'
import resolve from '@rollup/plugin-node-resolve'
import { rollup } from 'rollup'

const bundle = await rollup({
	input: 'src/widget-workbench.tsx',
	plugins: [
		resolve({ extensions: ['.tsx', '.ts', '.jsx', '.js'], browser: true }),
		babel({
			extensions: ['.ts', '.tsx', '.js', '.jsx'],
			babelHelpers: 'bundled',
			presets: [
				['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
				['babel-preset-solid', { generate: 'dom' }],
			],
		}),
	],
})
await bundle.write({ file: 'dist/workbench.js', format: 'es' })
await bundle.close()
