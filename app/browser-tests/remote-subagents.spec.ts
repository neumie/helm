import { expect, test } from '@playwright/test'

// Opt-in workbench DTOs, production workspace/poll/freshness, never the frozen benchmark.
test('native-idle subagents render list and live marker without authorizing Interrupt', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--subagents&viewMode=story')
	await expect(page.getByText('Subagents active', { exact: true }).first()).toBeVisible()
	await page.locator('.remote-session-row').first().click()
	await expect(page.getByRole('status', { name: 'Subagents are active', exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Interrupt', exact: true })).toHaveCount(0)
	await page.evaluate(() => window.__remoteFixture?.setActivity('working'))
	await expect(page.getByRole('status', { name: 'Pi is working', exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible()
	await expect(page.getByRole('status', { name: 'Subagents are active', exact: true })).toHaveCount(0)
})

test('source-negative and unavailable clear the marker without changing native idle', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--subagents&viewMode=story')
	await page.locator('.remote-session-row').first().click()
	await expect(page.getByRole('status', { name: 'Subagents are active', exact: true })).toBeVisible()
	await page.evaluate(() => {
		const fixture = window.__remoteFixture
		if (!fixture) throw new Error('Missing fixture')
		const detail = fixture.transport.detail.bind(fixture.transport)
		fixture.transport.detail = async (...args) => {
			const value = await detail(...args)
			return {
				...value,
				snapshot: {
					...value.snapshot,
					revision: value.snapshot.revision + 1,
					subagents: { availability: 'available', coverage: 'limited', active: false },
				},
			}
		}
	})
	await expect(page.getByRole('status', { name: 'Subagents are active', exact: true })).toHaveCount(0)
	await expect(page.getByText('Subagents: None active observed', { exact: true })).toBeVisible()
	await page.evaluate(() => {
		const fixture = window.__remoteFixture
		if (!fixture) throw new Error('Missing fixture')
		const detail = fixture.transport.detail.bind(fixture.transport)
		fixture.transport.detail = async (...args) => {
			const value = await detail(...args)
			return {
				...value,
				snapshot: {
					...value.snapshot,
					subagents: { availability: 'unavailable', coverage: 'unavailable', active: null },
					subagentsFreshForMs: undefined,
				},
			}
		}
	})
	await expect(page.getByText('Subagents: Unavailable', { exact: true })).toBeVisible()
	await expect(page.getByRole('status', { name: 'Subagents are active', exact: true })).toHaveCount(0)
})

test('receipt hook fences old errors, reentrant visibility, replacement and hidden reads', async ({ page }) => {
	const { build } = await import('esbuild')
	const { resolve } = await import('node:path')
	const app = resolve(__dirname, '..')
	const bundle = await build({
		stdin: {
			resolveDir: app,
			loader: 'tsx',
			contents: `
		import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
		import {useRemotePoll} from './src/renderer/remote/use-poll.ts';
		import {RemoteAccessError} from './src/renderer/remote/transport.ts';
		let hidden=false, pending=[], retired=[0,0], accepted=[0,0], hideOnAccept=false;
		Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
		const visibility=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'))};
		const readers=[0,1].map(id=>signal=>new Promise((resolve,reject)=>pending.push({id,resolve,reject,signal})));
		const receipts=[0,1].map(id=>({accepted(){accepted[id]++;if(hideOnAccept)visibility(true)},retire(){retired[id]++}}));
		const root=createRoot(document.getElementById('root'));
		function View({id,receipt,enabled}){const value=useRemotePoll(readers[id],30,{receipt:receipt===null?undefined:receipts[receipt],enabled});return <pre>{JSON.stringify(value)}</pre>}
		window.pollProof={mount(id=0,receipt=0,enabled=true){flushSync(()=>root.render(<View id={id} receipt={receipt} enabled={enabled}/>))},
		visibility,hideOnAccept(value){hideOnAccept=value},state(){return {pending:pending.length,retired,accepted,text:document.querySelector('pre')?.textContent}},
		settle(index,value,error){error?pending[index].reject(new RemoteAccessError(error)):pending[index].resolve(value)},unmount(){flushSync(()=>root.unmount())}};
	`,
		},
		bundle: true,
		platform: 'browser',
		format: 'iife',
		jsx: 'automatic',
		write: false,
	})
	await page.setContent('<div id="root"></div>')
	await page.addScriptTag({ content: bundle.outputFiles[0].text })
	const run = (code: string) => page.evaluate(code)
	await run('pollProof.mount()')
	await expect.poll(() => run('pollProof.state().pending')).toBe(1)
	await run('pollProof.mount(1,1)')
	await expect.poll(() => run('pollProof.state().pending')).toBe(2)
	await run('pollProof.settle(1,"new")')
	await expect.poll(() => run('pollProof.state().accepted[1]')).toBe(1)
	const retireBefore = await run('pollProof.state().retired[0]')
	await run('pollProof.settle(0,null,401)')
	await expect.poll(() => run('pollProof.state().retired[0]')).toBe(retireBefore)
	await expect(page.locator('pre')).toContainText('new')
	await expect.poll(() => run('pollProof.state().pending')).toBe(3)
	await run('pollProof.hideOnAccept(true);pollProof.settle(2,"hidden-result")')
	await expect.poll(() => run('pollProof.state().accepted[1]')).toBe(2)
	await expect(page.locator('pre')).not.toContainText('hidden-result')
	await run('pollProof.hideOnAccept(false);pollProof.visibility(false)')
	await expect.poll(() => run('pollProof.state().pending')).toBe(4)
	await run('pollProof.visibility(true);pollProof.visibility(false);pollProof.settle(3,"pre-hide")')
	await expect(page.locator('pre')).not.toContainText('pre-hide')
	await run('pollProof.visibility(true);pollProof.mount(0,null)')
	await expect.poll(() => run('pollProof.state().pending')).toBeGreaterThanOrEqual(5)
	await run('pollProof.settle(pollProof.state().pending-1,"ordinary-hidden")')
	await expect(page.locator('pre')).toContainText('ordinary-hidden')
	await run('pollProof.unmount()')
})

test('native browser lease timers renew, expire negative evidence, and retire without render churn', async ({
	page,
}) => {
	const { build } = await import('esbuild')
	const { resolve } = await import('node:path')
	const bundle = await build({
		stdin: {
			resolveDir: resolve(__dirname, '..'),
			loader: 'ts',
			contents: `
		import {RemoteSubagentFreshnessController} from './src/renderer/remote/subagent-freshness.ts';
		import {remoteDetailSchema} from '../src/remote/protocol.ts';
		window.timerProof=async()=>{
			const target={sessionId:'11111111-1111-7111-8111-111111111111',incarnation:'22222222-2222-4222-8222-222222222222',scopeId:null,generation:1};
			const epoch=target.incarnation, active={availability:'available',coverage:'limited',active:true}, negative={...active,active:false};
			const dto=(activity,revision=0)=>remoteDetailSchema.parse({protocol:1,hostEpoch:epoch,resync:true,snapshot:{target,revision,label:'Fixture',workspace:'Fixture',model:null,activity:'idle',capabilities:{prompt:true,interrupt:true,answer:false},question:null,messages:[],historyTruncated:false,connected:true,subagents:activity,subagentsFreshForMs:150}});
			const c=new RemoteSubagentFreshnessController();let notifications=0;c.subscribe(()=>notifications++);
			const check=(condition,label)=>{if(!condition)throw new Error(label)};
			c.replaceDetail(dto(active),performance.now());check(notifications===1,'positive publication');
			c.replaceDetail(dto(active),performance.now());check(notifications===1,'TTL-only churn');
			c.replaceDetail(dto(negative,1),performance.now());check(notifications===2,'negative publication');
			check(c.resolve(epoch,target,1,true,negative).active===false,'negative lease');
			await new Promise(r=>setTimeout(r,220));check(notifications===3,'native expiry publication');
			check(c.resolve(epoch,target,1,true,negative).availability==='unavailable','negative expiry');
			c.replaceDetail(dto(negative,1),performance.now());check(notifications===4,'recovery');
			c.retire();check(notifications===5,'retirement');c.retire();check(notifications===5,'duplicate retirement');
			c.replaceDetail(dto(active,0),performance.now());check(notifications===5,'old replay');
			c.dispose();return notifications;
		};
	`,
		},
		bundle: true,
		platform: 'browser',
		format: 'iife',
		write: false,
	})
	await page.setContent('<div></div>')
	await page.addScriptTag({ content: bundle.outputFiles[0].text })
	await expect(page.evaluate('timerProof()')).resolves.toBe(5)
})

test('receipt identity, disable, StrictMode, hidden start, auth and callback replacement fence admission', async ({
	page,
}) => {
	const { build } = await import('esbuild')
	const { resolve } = await import('node:path')
	const bundle = await build({
		stdin: {
			resolveDir: resolve(__dirname, '..'),
			loader: 'tsx',
			contents: `
 import React,{StrictMode} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
 import {useRemotePoll} from './src/renderer/remote/use-poll.ts';import {RemoteAccessError} from './src/renderer/remote/transport.ts';
 let hidden=false,pending=[],accepted=[0,0],retired=[0,0],replace=false;
 Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
 const visibility=v=>{hidden=v;document.dispatchEvent(new Event('visibilitychange'))};
 const read=signal=>new Promise((resolve,reject)=>pending.push({signal,resolve,reject}));
 const receipts=[0,1].map(id=>({accepted(){accepted[id]++;if(replace){replace=false;mount(1)}},retire(){retired[id]++}}));
 const root=createRoot(document.getElementById('root'));
 function View({id,enabled}){const s=useRemotePoll(read,10000,{receipt:receipts[id],enabled});return <pre>{s.error===401||s.error===403?'hidden:'+s.error:JSON.stringify(s)}</pre>}
 function mount(id=0,enabled=true){flushSync(()=>root.render(<StrictMode><View id={id} enabled={enabled}/></StrictMode>))}
 window.matrix={mount,visibility,replace(){replace=true},settle(i,value,error){error?pending[i].reject(new RemoteAccessError(error)):pending[i].resolve(value)},state(){return {pending:pending.length,accepted,retired,aborted:pending.map(p=>p.signal.aborted)}},unmount(){flushSync(()=>root.unmount())}};
 `,
		},
		bundle: true,
		platform: 'browser',
		format: 'iife',
		jsx: 'automatic',
		write: false,
	})
	await page.setContent('<div id="root"></div>')
	await page.addScriptTag({ content: bundle.outputFiles[0].text })
	const run = (code: string) => page.evaluate(code)
	await run('matrix.visibility(true);matrix.mount()')
	expect(await run('matrix.state().pending')).toBe(0)
	await run('matrix.visibility(false)')
	await expect.poll(() => run('matrix.state().pending')).toBe(1)
	await run('matrix.mount(1)')
	await expect.poll(() => run('matrix.state().pending')).toBe(2)
	await run('matrix.settle(0,"old-receipt");matrix.settle(1,"current")')
	await expect(page.locator('pre')).toContainText('current')
	expect(await run('matrix.state().accepted')).toEqual([0, 1])
	await run('matrix.mount(1,false);matrix.mount(1,true)')
	await expect.poll(() => run('matrix.state().pending')).toBe(3)
	await run('matrix.mount(1,false)')
	const before = await run('matrix.state().accepted[1]')
	await run('matrix.settle(2,"disabled")')
	expect(await run('matrix.state().accepted[1]')).toBe(before)
	await run('matrix.mount(0,true)')
	await expect.poll(() => run('matrix.state().pending')).toBe(4)
	await run('matrix.replace();matrix.settle(3,"callback-old")')
	await expect.poll(() => run('matrix.state().pending')).toBe(5)
	await expect(page.locator('pre')).not.toContainText('callback-old')
	await run('matrix.settle(4,"replacement")')
	await expect(page.locator('pre')).toContainText('replacement')
	for (const status of [401, 403]) {
		await run('matrix.mount(1,false);matrix.mount(1,true)')
		const index = (await run('matrix.state().pending-1')) as number
		const retired = (await run('matrix.state().retired[1]')) as number
		await page.evaluate(
			({ index, status }) => {
				const proof = window as unknown as { matrix: { settle(index: number, value: null, error: number): void } }
				proof.matrix.settle(index, null, status)
			},
			{ index, status },
		)
		await expect(page.locator('pre')).toHaveText(`hidden:${status}`)
		expect(await run('matrix.state().retired[1]')).toBe(retired + 1)
	}
	await run('matrix.unmount()')
	// A visible StrictMode mount admits the first setup, cleans it up, then reuses
	// the same receipt/controller identity for the live second setup.
	await page.setContent('<div id="root"></div>')
	await page.addScriptTag({ content: bundle.outputFiles[0].text })
	await run('matrix.mount()')
	await expect.poll(() => run('matrix.state().pending')).toBe(2)
	expect(await run('matrix.state().aborted')).toEqual([true, false])
	const strictRetired = await run('matrix.state().retired[0]')
	await run('matrix.settle(0,null,401);matrix.settle(1,"strict-current")')
	await expect(page.locator('pre')).toContainText('strict-current')
	expect(await run('matrix.state().retired[0]')).toBe(strictRetired)
	expect(await run('matrix.state().accepted')).toEqual([1, 0])
	await run('matrix.unmount()')
})

for (const kind of ['detail', 'directory'])
	test(`${kind} React recovers after suspended expiry and equal renewals do not commit`, async ({ page }) => {
		const { build } = await import('esbuild')
		const { resolve } = await import('node:path')
		const bundle = await build({
			stdin: {
				resolveDir: resolve(__dirname, '..'),
				loader: 'tsx',
				contents: `
 import React,{Profiler,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
 import {RemoteSubagentFreshnessController} from './src/renderer/remote/subagent-freshness.ts';
 import {remoteDetailSchema,remoteDirectorySchema} from '../src/remote/protocol.ts';
 let now=0,commits=0;const c=new RemoteSubagentFreshnessController(()=>now,{setTimeout:()=>1,clearTimeout:()=>{}});
 const target={sessionId:'11111111-1111-7111-8111-111111111111',incarnation:'22222222-2222-4222-8222-222222222222',scopeId:null,generation:1},host=target.incarnation;
 const activity={availability:'available',coverage:'limited',active:true};
 const row={target,revision:0,label:'Fixture',workspace:'Fixture',model:null,activity:'idle',capabilities:{prompt:true,interrupt:true,answer:false},historyTruncated:false,connected:true,subagents:activity,subagentsFreshForMs:100};
 const dto=${JSON.stringify(kind)}==='detail'?remoteDetailSchema.parse({protocol:1,hostEpoch:host,resync:true,snapshot:{...row,messages:[],question:null}}):remoteDirectorySchema.parse({protocol:1,hostEpoch:host,overlayStamp:'fixture',sessions:[row]});
 const receive=()=>${JSON.stringify(kind)}==='detail'?c.replaceDetail(dto,now):c.replaceDirectory(dto,now);
 function View(){useSyncExternalStore(c.subscribe,c.getSnapshot);return <p>{c.resolve(host,target,0,true,activity).availability}</p>}
 const root=createRoot(document.getElementById('root'));const render=()=>flushSync(()=>root.render(<Profiler id="small correctness fixture" onRender={()=>commits++}><View/></Profiler>));
 window.recovery={render,receive(){flushSync(receive)},expire(){now=200},commits:()=>commits};receive();render();
 `,
			},
			bundle: true,
			platform: 'browser',
			format: 'iife',
			jsx: 'automatic',
			write: false,
		})
		await page.setContent('<div id="root"></div>')
		await page.addScriptTag({ content: bundle.outputFiles[0].text })
		await expect(page.locator('p')).toHaveText('available')
		await page.evaluate('recovery.expire();recovery.render()')
		await expect(page.locator('p')).toHaveText('unavailable')
		await page.evaluate('recovery.receive()')
		await expect(page.locator('p')).toHaveText('available')
		const commits = await page.evaluate('recovery.commits()')
		await page.evaluate('recovery.receive();recovery.receive()')
		expect(await page.evaluate('recovery.commits()')).toBe(commits)
	})

for (const active of [true, false])
	test(`HTTP poll leases keep two owners and selected ${active ? 'positive' : 'negative'} evidence independent`, async ({
		page,
	}) => {
		const { build } = await import('esbuild')
		const { resolve } = await import('node:path')
		const target = {
			sessionId: '11111111-1111-7111-8111-111111111111',
			incarnation: '22222222-2222-4222-8222-222222222222',
			scopeId: null,
			generation: 1,
		}
		const peer = { ...target, sessionId: '33333333-3333-4333-8333-333333333333' }
		const row = (owner: typeof target, ttl: number, value: boolean) => ({
			target: owner,
			revision: 0,
			label: 'Fixture',
			workspace: 'Fixture',
			model: null,
			activity: 'idle',
			capabilities: { prompt: true, interrupt: true, answer: false },
			historyTruncated: false,
			connected: true,
			subagents: { availability: 'available', coverage: 'limited', active: value },
			subagentsFreshForMs: ttl,
		})
		const detail = (ttl: number) => ({
			protocol: 1,
			hostEpoch: target.incarnation,
			resync: true,
			snapshot: { ...row(target, ttl, active), question: null, messages: [] },
		})
		const directory = {
			protocol: 1,
			hostEpoch: target.incarnation,
			overlayStamp: 'fixture',
			sessions: [row(target, 200, active), row(peer, 5000, false)],
		}
		const held: import('@playwright/test').Route[] = []
		let directories = 0
		await page.route('http://127.0.0.1:31994/**', async route => {
			const path = new URL(route.request().url()).pathname
			if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
			expect(route.request().headers()['x-helm-subagent-activity']).toBe('1')
			if (path === '/v1/sessions') {
				directories++
				if (directories === 1) return route.fulfill({ json: directory, headers: { 'X-Helm-Subagent-Activity': '1' } })
			}
			held.push(route)
		})
		await page.goto('http://127.0.0.1:31994/')
		const bundle = await build({
			stdin: {
				resolveDir: resolve(__dirname, '..'),
				loader: 'tsx',
				contents: `
 import React,{Profiler,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
 import {createRemoteTransport} from './src/renderer/remote/transport.ts';import {useRemotePoll} from './src/renderer/remote/use-poll.ts';
 import {RemoteSubagentFreshnessController} from './src/renderer/remote/subagent-freshness.ts';
 import {sameRemoteDirectory,sameRemoteDetail} from './src/renderer/remote/remote-poll-equality.ts';
 const target=${JSON.stringify(target)},transport=createRemoteTransport(),d=new RemoteSubagentFreshnessController(),s=new RemoteSubagentFreshnessController();
 let commits=0,receipts=0;const Transcript=React.memo(function Transcript({value}){return <Profiler id="tiny memo transcript" onRender={()=>commits++}><div id="transcript">Fixed small correctness transcript</div></Profiler>});const rd=signal=>transport.directory(signal),rs=signal=>transport.detail(target.sessionId,signal);
 const dr={accepted:(v,t)=>d.replaceDirectory(v,t),retire:()=>d.retire()},sr={accepted:(v,t)=>{receipts++;s.replaceDetail(v,t)},retire:()=>s.retire()};
 function View(){const directory=useRemotePoll(rd,10000,{receipt:dr,equal:sameRemoteDirectory}),detail=useRemotePoll(rs,20,{receipt:sr,equal:sameRemoteDetail});
 useSyncExternalStore(d.subscribe,d.getSnapshot);useSyncExternalStore(s.subscribe,s.getSnapshot);
 const resolve=(c,host,row)=>row?JSON.stringify(c.resolve(host,row.target,row.revision,row.connected,row.subagents)):'loading';
 return <><p id="a">{resolve(d,directory.value?.hostEpoch,directory.value?.sessions[0])}</p><p id="b">{resolve(d,directory.value?.hostEpoch,directory.value?.sessions[1])}</p><p id="selected">{resolve(s,detail.value?.hostEpoch,detail.value?.snapshot)}</p><Transcript value={detail.value}/></>}
 createRoot(document.getElementById('root')).render(<View/>);
 window.leases={state:()=>({commits,receipts,publications:s.getSnapshot()})};
 `,
			},
			bundle: true,
			platform: 'browser',
			format: 'iife',
			jsx: 'automatic',
			write: false,
		})
		await page.addScriptTag({ content: bundle.outputFiles[0].text })
		await expect.poll(() => held.length).toBe(1)
		await held[0].fulfill({ json: detail(1000), headers: { 'X-Helm-Subagent-Activity': '1' } })
		await expect(page.locator('#selected')).toContainText(`"active":${active}`)
		await expect.poll(() => held.length).toBe(2)
		await expect(page.locator('#a')).toContainText('unavailable')
		await expect(page.locator('#b')).toContainText('"active":false')
		await expect(page.locator('#selected')).toContainText(`"active":${active}`)
		// The held successor was admitted before the prior lease expired, but owns no lease.
		await expect(page.locator('#selected')).toContainText('unavailable')
		await held[1].fulfill({ json: detail(100), headers: { 'X-Helm-Subagent-Activity': '1' } })
		await expect.poll(() => page.evaluate('leases.state().receipts')).toBe(2)
		await expect(page.locator('#selected')).toContainText('unavailable')
		await expect.poll(() => held.length).toBe(3)
		await held[2].fulfill({ json: detail(2000), headers: { 'X-Helm-Subagent-Activity': '1' } })
		await expect(page.locator('#selected')).toContainText(`"active":${active}`)
		const commits = await page.evaluate('leases.state().commits')
		const publications = await page.evaluate('leases.state().publications')
		for (let i = 3; i < 6; i++) {
			await expect.poll(() => held.length).toBe(i + 1)
			await held[i].fulfill({ json: detail(2000 - i), headers: { 'X-Helm-Subagent-Activity': '1' } })
			await expect.poll(() => page.evaluate('leases.state().receipts')).toBe(i + 1)
			expect(await page.evaluate('leases.state().commits')).toBe(commits)
			expect(await page.evaluate('leases.state().publications')).toBe(publications)
		}
	})
