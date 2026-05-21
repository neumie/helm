import { cpSync } from 'node:fs'
import babel from '@rollup/plugin-babel'
import resolve from '@rollup/plugin-node-resolve'
import { rollup } from 'rollup'

const plugins = [
	resolve({ extensions: ['.tsx', '.ts', '.jsx', '.js'] }),
	babel({
		extensions: ['.ts', '.tsx', '.js', '.jsx'],
		babelHelpers: 'bundled',
		presets: [
			['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
			['babel-preset-solid', { generate: 'dom' }],
		],
	}),
]

// Content script
const content = await rollup({ input: 'src/content.tsx', plugins })
await content.write({ file: 'dist/content.js', format: 'iife' })
await content.close()

// Popup script
const popup = await rollup({ input: 'src/popup.ts', plugins })
await popup.write({ file: 'dist/popup.js', format: 'iife' })
await popup.close()

// Copy static files
cpSync('manifest.json', 'dist/manifest.json')
cpSync('src/popup.html', 'dist/popup.html')

console.log('Extension built to dist/')
