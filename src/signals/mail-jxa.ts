// The read-only JXA script the Mail Signals reader runs through `osascript -l JavaScript`.
//
// It never launches Mail (checks `running()` first), never changes Mail state (no readStatus
// writes, no moves) and never sends anything. Message properties are read in batches over one
// `whose` specifier; raw headers are read only for the bounded candidate set and are reduced
// inside the script to `bulk` + conversation `root`, so headers never leave it.

/** Script arguments (one JSON argv element). */
export interface MailScriptArgs {
	/** ISO time; only inbox messages received after it are read. */
	since: string
	/**
	 * Anchored, case-insensitive regex sources: senders that are candidates even when read. Sentry
	 * senders (mail-filter's `isSentrySender`) are always candidates, listed here or not.
	 */
	include: string[]
	/** When false every recent message is a candidate, not only unread ones. */
	unreadOnly: boolean
	/** Newest messages kept from the inbox window (`truncated` when more). */
	maxMessages: number
	/** Candidates whose headers are read (`truncated` when more). */
	maxCandidates: number
}

export const MAIL_MAX_MESSAGES = 300
export const MAIL_MAX_CANDIDATES = 60
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
		return domain === 'sentry.io' || /\.sentry\.io$/.test(domain) ||
			domain === 'getsentry.com' || /\.getsentry\.com$/.test(domain);
	}
	function isBulk(h) {
		if (h['list-id'] || h['list-unsubscribe']) return true;
		var precedence = (h['precedence'] || []).join(' ').trim().toLowerCase();
		if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true;
		var auto = h['auto-submitted'];
		return !!auto && auto.join(' ').trim().toLowerCase() !== 'no';
	}

	var include = args.include.map(function (source) { return new RegExp(source, 'i'); });
	var msgs = Mail.inbox.messages.whose({ dateReceived: { _greaterThan: new Date(args.since) } });
	var ids = msgs.id();
	var messageIds = msgs.messageId();
	var subjects = msgs.subject();
	var senders = msgs.sender();
	var dates = msgs.dateReceived();
	var reads = msgs.readStatus();
	var flags = msgs.flaggedStatus();

	var order = [];
	for (var i = 0; i < ids.length; i++) if (dates[i] instanceof Date) order.push(i);
	order.sort(function (a, b) { return dates[b].getTime() - dates[a].getTime(); });
	var truncated = order.length > args.maxMessages;
	order = order.slice(0, args.maxMessages);

	var candidates = [];
	for (var c = 0; c < order.length; c++) {
		var index = order[c];
		var sender = parseSender(senders[index]);
		var wanted = !args.unreadOnly || !reads[index] || isSentry(sender.address) ||
			include.some(function (re) { return re.test(sender.address); });
		if (!wanted) continue;
		if (candidates.length >= args.maxCandidates) { truncated = true; break; }
		candidates.push({ index: index, sender: sender });
	}

	var messages = [];
	for (var k = 0; k < candidates.length; k++) {
		var at = candidates[k].index;
		try {
			var message = msgs[at];
			if (message.id() !== ids[at]) { truncated = true; continue; }
			var headers = headerMap(message.allHeaders());
			var ownId = text(messageIds[at]).replace(/^<|>$/g, '');
			if (!ownId) { truncated = true; continue; }
			messages.push({
				messageId: ownId,
				subject: text(subjects[at]),
				senderName: candidates[k].sender.name,
				senderAddress: candidates[k].sender.address,
				dateReceived: dates[at].toISOString(),
				read: !!reads[at],
				flagged: !!flags[at],
				bulk: isBulk(headers),
				root: firstId(headers['references']) || firstId(headers['in-reply-to']) || ownId,
			});
		} catch (error) {
			truncated = true;
		}
	}

	var myAddresses = [];
	try {
		var lists = Mail.accounts.emailAddresses();
		for (var a = 0; a < lists.length; a++) {
			var list = lists[a] || [];
			for (var b = 0; b < list.length; b++) myAddresses.push(text(list[b]));
		}
	} catch (error) {}

	return JSON.stringify({ running: true, truncated: truncated, myAddresses: myAddresses, messages: messages });
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
