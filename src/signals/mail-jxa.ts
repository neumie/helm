// The read-only JXA script the Mail Signals reader runs through `osascript -l JavaScript`.
//
// It never launches Mail (checks `running()` first), never changes Mail state (no readStatus
// writes, no moves) and never sends anything.
//
// Speed: Mail serves one Apple event at a time and each can take seconds while it syncs, so the
// script keeps the number of events small and each one cheap. It reads every account's own inbox
// (never the unified Mail.inbox, which Mail evaluates across all accounts on every request) with
// whole-list property reads (one event per property per mailbox, never a `whose` filter, which
// Mail re-evaluates over the whole mailbox for every property asked). The received dates decide the
// window first; subjects and flags are read only for mailboxes with a candidate, and raw headers
// only for the bounded candidate set, one message by id each. Headers are reduced inside the
// script to `bulk` + conversation `root` + Message-ID, so they never leave it. Past `budgetMs` it
// stops starting new reads and returns a partial answer (`slow`).
//
// Besides the inboxes it reads the extra mailboxes Jakub configured by name
// (`signals.mail.mailboxes`, e.g. a Gmail label a server-side filter files mail into). Nothing is
// ever added implicitly: All Mail, Trash, Spam and Sent are read only when listed by name.

/** Script arguments (one JSON argv element). */
export interface MailScriptArgs {
	/** ISO time; only messages received after it are read. */
	since: string
	/**
	 * Extra mailboxes read besides the inbox: a mailbox name (`Clientcare`), optionally qualified
	 * with its account name or address (`neumann@contember.com/Clientcare`); case-insensitive. See
	 * mail-filter's `mailboxEntryMatches`, which `mailboxMatches` in the script mirrors.
	 */
	mailboxes: string[]
	/**
	 * Anchored, case-insensitive regex sources: senders that are candidates even when read. Sentry
	 * senders (mail-filter's `isSentrySender`) are always candidates, listed here or not.
	 */
	include: string[]
	/** When false every recent message is a candidate, not only unread ones. */
	unreadOnly: boolean
	/** Newest messages kept from each mailbox's window (`truncated` when more). */
	maxMessages: number
	/** Inbox candidates whose headers are read (`truncated` when more). */
	maxCandidates: number
	/**
	 * Candidates from the extra mailboxes together, a budget of their own so a busy label never
	 * crowds inbox mail out (`truncated` and the mailbox in `cappedMailboxes` when more).
	 */
	maxMailboxCandidates: number
	/** After this many ms no new read starts; the answer is partial (`slow`, `truncated`). 0 = none. */
	budgetMs: number
}

export const MAIL_MAX_MESSAGES = 300
export const MAIL_MAX_CANDIDATES = 60
export const MAIL_MAX_MAILBOX_CANDIDATES = 60
/** Extra mailboxes read per poll, after name matching (`truncated` when more match). */
export const MAIL_MAX_MAILBOXES = 12
/** Bound for configured mailbox entries the reader passes on (more are ignored and reported). */
export const MAIL_MAX_MAILBOX_ENTRIES = 20
/**
 * Reading budget of one poll. The osascript timeout (mail-source) leaves room above it for the
 * one Apple event in flight when the budget runs out.
 */
export const MAIL_SCRIPT_BUDGET_MS = 25_000
/** Bound for subject/sender strings the script returns (the mapper bounds again). */
const SCRIPT_TEXT_MAX = 1000

export const MAIL_JXA_SCRIPT = `
function run(argv) {
	var args = JSON.parse(argv[argv.length - 1]);
	var Mail = Application('Mail');
	if (!Mail.running()) return JSON.stringify({ running: false });
	var MAX = ${SCRIPT_TEXT_MAX};
	function text(value) {
		var s = value === null || value === undefined ? '' : String(value);
		return s.length > MAX ? s.slice(0, MAX) : s;
	}
	function parseSender(value) {
		var s = text(value);
		var m = s.match(/^\\s*"?([^"<]*?)"?\\s*<([^<>]+)>\\s*$/);
		return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: s.trim() };
	}
	function headerMap(raw) {
		var out = {};
		var lines = String(raw || '').split(/\\r?\\n/);
		var current = null;
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			if (line === '') break;
			if (/^[ \\t]/.test(line)) {
				if (current) out[current][out[current].length - 1] += ' ' + line.trim();
				continue;
			}
			var colon = line.indexOf(':');
			if (colon <= 0) { current = null; continue; }
			current = line.slice(0, colon).trim().toLowerCase();
			(out[current] = out[current] || []).push(line.slice(colon + 1).trim());
		}
		return out;
	}
	function firstId(values) {
		if (!values) return null;
		var m = values.join(' ').match(/<([^<>\\s]+)>/);
		return m ? m[1] : null;
	}
	// Mirrors mail-filter.ts isSentrySender: sentry.io, getsentry.com and their subdomains.
	function isSentry(address) {
		var at = address.lastIndexOf('@');
		var domain = at === -1 ? '' : address.slice(at + 1).toLowerCase();
		return domain === 'sentry.io' || /\\.sentry\\.io$/.test(domain) ||
			domain === 'getsentry.com' || /\\.getsentry\\.com$/.test(domain);
	}
	// Mirrors mail-filter.ts relayedSenderAddress: the original sender behind an Apple Hide My
	// Email relay address, else null.
	function relayDecode(address) {
		var normalized = String(address).trim().toLowerCase();
		var at = normalized.lastIndexOf('@');
		if (at <= 0) return null;
		var domain = normalized.slice(at + 1);
		if (domain !== 'privaterelay.appleid.com' && domain !== 'private.icloud.com' && domain !== 'icloud.com') {
			return null;
		}
		var local = normalized.slice(0, at);
		if (local.length > 400) return null;
		var m = local.match(/^(.+?)_at_([a-z0-9-]+(?:_[a-z0-9-]+)+)_[a-z0-9]{6,16}_[0-9a-f]{6,16}$/);
		if (!m) return null;
		var labels = m[2].split('_');
		for (var i = 0; i < labels.length; i++) {
			if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(labels[i])) return null;
		}
		if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(labels[labels.length - 1])) return null;
		return m[1] + '@' + labels.join('.');
	}
	// Header-only markers of mail sent to many. List-Unsubscribe-Post counts alone because Apple's
	// Hide My Email relay strips List-Unsubscribe and List-Id but keeps it; X-Campaign names are
	// exact (Mailchimp, Iterable, SmartEmailing), never a prefix. Transport fingerprints never
	// count: Feedback-ID, X-SES-*, X-SG-*, X-Mailgun-*, X-PM-*, X-Mandrill-* and
	// X-Auto-Response-Suppress also ride on helpdesk agents' replies (Freshdesk, Gorgias, Front,
	// Zendesk) and on DocuSign or payment mail.
	function isBulk(h) {
		if (h['list-id'] || h['list-unsubscribe'] || h['list-unsubscribe-post']) return true;
		if (h['x-campaign'] || h['x-campaignid'] || h['x-campaign-id']) return true;
		var precedence = (h['precedence'] || []).join(' ').trim().toLowerCase();
		if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true;
		var auto = h['auto-submitted'];
		return !!auto && auto.join(' ').trim().toLowerCase() !== 'no';
	}
	// Mirrors mail-filter.ts mailboxEntryMatches: the entry is the mailbox name, or
	// "<account name or address>/<mailbox name>"; case-insensitive. account is null for local
	// (On My Mac) mailboxes, which match unqualified entries only.
	function mailboxMatches(entry, account, mailbox) {
		var e = String(entry).trim().toLowerCase();
		var name = String(mailbox).trim().toLowerCase();
		if (e === '' || name === '') return false;
		if (e === name) return true;
		if (!account) return false;
		var slash = e.indexOf('/');
		if (slash <= 0) return false;
		var qualifier = e.slice(0, slash).trim();
		if (e.slice(slash + 1).trim() !== name) return false;
		if (qualifier === String(account.name).trim().toLowerCase()) return true;
		for (var i = 0; i < account.addresses.length; i++) {
			if (qualifier === String(account.addresses[i]).trim().toLowerCase()) return true;
		}
		return false;
	}
	// One Message-ID spelling for deduping the same mail across mailboxes (Gmail labels).
	function idKey(value) {
		return text(value).trim().replace(/^<|>$/g, '').toLowerCase();
	}

	var include = args.include.map(function (source) { return new RegExp(source, 'i'); });
	var sinceMs = new Date(args.since).getTime();
	var started = Date.now();
	var truncated = false;
	// Mail answers one Apple event at a time and can take seconds per event while it syncs. Past
	// the budget the script stops starting new reads and returns what it has (slow + truncated),
	// so a slow Mail yields a partial poll instead of a killed one.
	var slow = false;
	function late() {
		if (args.budgetMs > 0 && Date.now() - started > args.budgetMs) {
			slow = true;
			truncated = true;
		}
		return slow;
	}
	// Configured entries no mailbox matched / mailboxes Mail failed to list or read / mailboxes
	// with more mail than one poll reads / matching mailboxes beyond the bound.
	var missing = [];
	var unreadable = [];
	var capped = [];
	var skipped = [];
	function note(list, label) {
		if (list.indexOf(label) === -1 && list.length < 50) list.push(label);
	}

	// Each account's own inbox, not the unified Mail.inbox: Mail evaluates the unified inbox across
	// every account on each request, which made one poll take tens of seconds. Listing fails only
	// when Mail cannot be read at all (no permission, Mail quit), which fails the whole read.
	var sources = [];
	var inboxes = Mail.inbox.mailboxes();
	if (inboxes.length === 0) {
		sources.push({ inbox: true, label: null, mailbox: Mail.inbox });
	} else {
		for (var ib = 0; ib < inboxes.length; ib++) sources.push({ inbox: true, label: null, mailbox: inboxes[ib] });
	}

	// Then every mailbox whose name matches a configured entry, each once, in the order of the
	// entries (so with both "Clientcare" and "All Mail" listed, mail in both reads as Clientcare).
	var wantedBoxes = args.mailboxes || [];
	if (wantedBoxes.length > 0) {
		var found = wantedBoxes.map(function () { return false; });
		var matched = [];
		var addBoxes = function (account, container) {
			var names = container.mailboxes.name();
			for (var n = 0; n < names.length; n++) {
				var first = -1;
				for (var w = 0; w < wantedBoxes.length; w++) {
					if (mailboxMatches(wantedBoxes[w], account, names[n])) {
						found[w] = true;
						if (first === -1) first = w;
					}
				}
				if (first === -1) continue;
				matched.push({ entry: first, seq: matched.length, label: text(names[n]).slice(0, 80), mailbox: container.mailboxes[n] });
			}
		};
		// A mailbox list that could not be read makes its unmatched entries unreadable, not missing.
		var listed = true;
		try {
			addBoxes(null, Mail);
		} catch (error) {
			listed = false;
			note(unreadable, 'On My Mac mailbox list');
		}
		var accounts = [];
		try {
			accounts = Mail.accounts();
		} catch (error) {
			listed = false;
			note(unreadable, 'account list');
		}
		for (var ac = 0; ac < accounts.length; ac++) {
			var accountName = 'an account';
			try {
				accountName = text(accounts[ac].name()).slice(0, 80) || accountName;
				var account = { name: accountName, addresses: accounts[ac].emailAddresses() || [] };
				addBoxes(account, accounts[ac]);
			} catch (error) {
				listed = false;
				note(unreadable, accountName + ' mailbox list');
			}
		}
		if (!listed) truncated = true;
		for (var f = 0; f < wantedBoxes.length; f++) {
			if (!found[f]) note(listed ? missing : unreadable, text(wantedBoxes[f]).slice(0, 200));
		}
		matched.sort(function (a, b) { return a.entry - b.entry || a.seq - b.seq; });
		for (var mb = 0; mb < matched.length; mb++) {
			if (mb >= ${MAIL_MAX_MAILBOXES}) {
				truncated = true;
				note(skipped, matched[mb].label);
				continue;
			}
			sources.push({ inbox: false, label: matched[mb].label, mailbox: matched[mb].mailbox });
		}
	}

	function sameList(a, b) {
		if (a.length !== b.length) return false;
		for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
		return true;
	}
	function wantedSender(read, sender) {
		var decoded = relayDecode(sender.address);
		return !args.unreadOnly || !read || isSentry(sender.address) ||
			(decoded !== null && isSentry(decoded)) ||
			include.some(function (re) { return re.test(sender.address) || (decoded !== null && re.test(decoded)); });
	}
	// One mailbox: whole-list reads only, one Apple event per property and never a whose()
	// filter, which Mail re-evaluates over the whole mailbox on every property it is asked for.
	// The received dates decide the window first, so a mailbox with nothing recent costs one
	// event. Subjects and flags are read only when the mailbox has a candidate. Lists come in one
	// order per request; when the mailbox changes between requests (mail arrives or leaves) the
	// lists disagree and the mailbox is read once more. Returns null when it kept changing.
	function readSource(source) {
		for (var attempt = 0; attempt < 2; attempt++) {
			var list = source.mailbox.messages;
			var dates = list.dateReceived();
			var window = [];
			for (var i = 0; i < dates.length; i++) {
				var d = dates[i];
				if (d && typeof d.getTime === 'function' && d.getTime() > sinceMs) window.push(i);
			}
			if (window.length === 0) return { rows: [], over: false };
			window.sort(function (a, b) { return dates[b].getTime() - dates[a].getTime(); });
			var over = window.length > args.maxMessages;
			window = window.slice(0, args.maxMessages);
			var n = dates.length;
			var ids = list.id();
			var reads = list.readStatus();
			var senders = list.sender();
			if (ids.length !== n || reads.length !== n || senders.length !== n) continue;
			var rows = [];
			for (var w = 0; w < window.length; w++) {
				var index = window[w];
				var sender = parseSender(senders[index]);
				if (!wantedSender(reads[index], sender)) continue;
				rows.push({ index: index, id: ids[index], date: dates[index], read: reads[index], sender: sender });
			}
			if (rows.length === 0) return { rows: [], over: over };
			var subjects = list.subject();
			var flags = list.flaggedStatus();
			if (subjects.length !== n || flags.length !== n || !sameList(list.id(), ids)) continue;
			for (var r = 0; r < rows.length; r++) {
				rows[r].subject = subjects[rows[r].index];
				rows[r].flagged = flags[rows[r].index];
			}
			return { rows: rows, over: over };
		}
		return null;
	}
	function inboxLabel(source) {
		try {
			return (text(source.mailbox.account.name()).slice(0, 80) || 'an account') + ' inbox';
		} catch (error) {
			return 'an inbox';
		}
	}

	// Candidates of every source; the inbox and the extra mailboxes each fill their own budget.
	var inboxRows = [];
	var mailboxRows = [];
	var inboxesRead = 0;
	var inboxError = null;
	for (var s = 0; s < sources.length; s++) {
		var source = sources[s];
		if (!source.inbox && inboxesRead === 0 && inboxError !== null) throw inboxError;
		if (late()) break;
		var got;
		try {
			got = readSource(source);
		} catch (error) {
			truncated = true;
			if (source.inbox) {
				// No inbox readable at all is the whole read failing (no permission, Mail quit).
				if (inboxError === null) inboxError = error;
				note(unreadable, inboxLabel(source));
			} else {
				note(unreadable, source.label);
			}
			continue;
		}
		if (source.inbox) inboxesRead++;
		if (got === null) {
			truncated = true;
			note(unreadable, source.inbox ? inboxLabel(source) : source.label);
			continue;
		}
		if (got.over) {
			truncated = true;
			if (!source.inbox) note(capped, source.label);
		}
		for (var g = 0; g < got.rows.length; g++) {
			got.rows[g].source = source;
			got.rows[g].order = s;
			(source.inbox ? inboxRows : mailboxRows).push(got.rows[g]);
		}
	}
	if (inboxesRead === 0 && inboxError !== null) throw inboxError;
	function newestFirst(a, b) { return b.date.getTime() - a.date.getTime() || a.order - b.order; }
	inboxRows.sort(newestFirst);
	mailboxRows.sort(newestFirst);

	// Headers only for candidates, one message at a time by id (stable while the mailbox changes).
	// The same mail in several mailboxes (a Gmail label beside the inbox, one mail delivered to two
	// accounts) is read once: the inbox copy first, then the first mailbox listed.
	var messages = [];
	var seen = {};
	function take(row) {
		var message = row.source.mailbox.messages.byId(row.id);
		var headers = headerMap(message.allHeaders());
		var ownId = firstId(headers['message-id']) || text(message.messageId()).trim().replace(/^<|>$/g, '');
		if (!ownId) {
			truncated = true;
			return false;
		}
		var key = idKey(ownId);
		if (seen[key]) return false;
		seen[key] = true;
		messages.push({
			messageId: ownId,
			subject: text(row.subject),
			senderName: row.sender.name,
			senderAddress: row.sender.address,
			dateReceived: row.date.toISOString(),
			read: !!row.read,
			flagged: !!row.flagged,
			bulk: isBulk(headers),
			root: firstId(headers['references']) || firstId(headers['in-reply-to']) || ownId,
			mailbox: row.source.label,
		});
		return true;
	}
	function takeAll(rows, max) {
		var count = 0;
		for (var k = 0; k < rows.length; k++) {
			if (count >= max) {
				truncated = true;
				if (rows[k].source.label !== null) note(capped, rows[k].source.label);
				continue;
			}
			if (late()) return;
			try {
				if (take(rows[k])) count++;
			} catch (error) {
				// Gone since the lists were read (moved, deleted).
				truncated = true;
			}
		}
	}
	takeAll(inboxRows, args.maxCandidates);
	takeAll(mailboxRows, args.maxMailboxCandidates);
	messages.sort(function (a, b) { return a.dateReceived < b.dateReceived ? 1 : a.dateReceived > b.dateReceived ? -1 : 0; });

	var myAddresses = [];
	try {
		var lists = Mail.accounts.emailAddresses();
		for (var a = 0; a < lists.length; a++) {
			var list = lists[a] || [];
			for (var b = 0; b < list.length; b++) myAddresses.push(text(list[b]));
		}
	} catch (error) {}

	return JSON.stringify({
		running: true, truncated: truncated, slow: slow, myAddresses: myAddresses, messages: messages,
		missingMailboxes: missing,
		unreadableMailboxes: unreadable,
		cappedMailboxes: capped,
		skippedMailboxes: skipped,
	});
}
`

/** The single JSON argv element for {@link MAIL_JXA_SCRIPT}. */
export function mailScriptArgument(args: MailScriptArgs): string {
	return JSON.stringify(args)
}

/** `osascript` argv: JavaScript language, the script inline, then its one JSON argument. */
export function mailOsascriptArgs(args: MailScriptArgs): string[] {
	return ['-l', 'JavaScript', '-e', MAIL_JXA_SCRIPT, '--', mailScriptArgument(args)]
}
