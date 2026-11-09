// The read-only JXA script the Mail Signals reader runs through `osascript -l JavaScript`.
//
// It never launches Mail (checks `running()` first), never changes Mail state (no readStatus
// writes, no moves) and never sends anything. Message properties are read in batches over one
// `whose` specifier per mailbox; raw headers are read only for the bounded candidate set and are
// reduced inside the script to `bulk` + conversation `root`, so headers never leave it.
//
// Besides the unified inbox it reads the extra mailboxes Jakub configured by name
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
}

export const MAIL_MAX_MESSAGES = 300
export const MAIL_MAX_CANDIDATES = 60
export const MAIL_MAX_MAILBOX_CANDIDATES = 60
/** Extra mailboxes read per poll, after name matching (`truncated` when more match). */
export const MAIL_MAX_MAILBOXES = 12
/** Bound for configured mailbox entries the reader passes on (more are ignored and reported). */
export const MAIL_MAX_MAILBOX_ENTRIES = 20
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
	var truncated = false;
	var since = { dateReceived: { _greaterThan: new Date(args.since) } };

	// Mailboxes to read: the inbox first (it wins the Message-ID dedupe), then every mailbox whose
	// name matches a configured entry, each once, in the order of the entries (so with both
	// "Clientcare" and "All Mail" listed, mail in both reads as Clientcare).
	var sources = [{ label: null, mailbox: Mail.inbox }];
	var wantedBoxes = args.mailboxes || [];
	// Configured entries no mailbox matched / mailboxes Mail failed to list or read / mailboxes
	// with more mail than one poll reads / matching mailboxes beyond the bound.
	var missing = [];
	var unreadable = [];
	var capped = [];
	var skipped = [];
	function note(list, label) {
		if (list.indexOf(label) === -1 && list.length < 50) list.push(label);
	}
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
			sources.push({ label: matched[mb].label, mailbox: matched[mb].mailbox });
		}
	}

	// Every message of every source window, newest first per mailbox and bounded per mailbox.
	var all = [];
	var seen = {};
	for (var s = 0; s < sources.length; s++) {
		var msgs, ids, messageIds, subjects, senders, dates, reads, flags;
		try {
			msgs = sources[s].mailbox.messages.whose(since);
			ids = msgs.id();
			messageIds = msgs.messageId();
			subjects = msgs.subject();
			senders = msgs.sender();
			dates = msgs.dateReceived();
			reads = msgs.readStatus();
			flags = msgs.flaggedStatus();
		} catch (error) {
			// The inbox read failing is the whole read failing (no permission, Mail quit); one extra
			// mailbox failing leaves the others readable.
			if (s === 0) throw error;
			truncated = true;
			note(unreadable, sources[s].label);
			continue;
		}
		var order = [];
		for (var i = 0; i < ids.length; i++) if (dates[i] instanceof Date) order.push(i);
		order.sort(function (a, b) { return dates[b].getTime() - dates[a].getTime(); });
		if (order.length > args.maxMessages) {
			truncated = true;
			if (s > 0) note(capped, sources[s].label);
		}
		order = order.slice(0, args.maxMessages);
		for (var o = 0; o < order.length; o++) {
			var index = order[o];
			// The same mail in several mailboxes (a Gmail label beside the inbox) is read once.
			var key = idKey(messageIds[index]);
			if (key !== '') {
				if (seen[key]) continue;
				seen[key] = true;
			}
			all.push({
				msgs: msgs,
				index: index,
				label: sources[s].label,
				id: ids[index],
				messageId: messageIds[index],
				subject: subjects[index],
				sender: senders[index],
				date: dates[index],
				read: reads[index],
				flagged: flags[index],
			});
		}
	}
	all.sort(function (a, b) { return b.date.getTime() - a.date.getTime(); });

	// Newest first; the inbox and the extra mailboxes each fill their own candidate budget.
	var candidates = [];
	var inboxCount = 0;
	var mailboxCount = 0;
	for (var c = 0; c < all.length; c++) {
		var entry = all[c];
		var sender = parseSender(entry.sender);
		var decoded = relayDecode(sender.address);
		var wanted = !args.unreadOnly || !entry.read || isSentry(sender.address) ||
			(decoded !== null && isSentry(decoded)) ||
			include.some(function (re) { return re.test(sender.address) || (decoded !== null && re.test(decoded)); });
		if (!wanted) continue;
		if (entry.label === null) {
			if (inboxCount >= args.maxCandidates) { truncated = true; continue; }
			inboxCount++;
		} else {
			if (mailboxCount >= args.maxMailboxCandidates) {
				truncated = true;
				note(capped, entry.label);
				continue;
			}
			mailboxCount++;
		}
		candidates.push({ entry: entry, sender: sender });
	}

	var messages = [];
	for (var k = 0; k < candidates.length; k++) {
		var at = candidates[k].entry;
		try {
			var message = at.msgs[at.index];
			if (message.id() !== at.id) { truncated = true; continue; }
			var headers = headerMap(message.allHeaders());
			var ownId = text(at.messageId).replace(/^<|>$/g, '');
			if (!ownId) { truncated = true; continue; }
			messages.push({
				messageId: ownId,
				subject: text(at.subject),
				senderName: candidates[k].sender.name,
				senderAddress: candidates[k].sender.address,
				dateReceived: at.date.toISOString(),
				read: !!at.read,
				flagged: !!at.flagged,
				bulk: isBulk(headers),
				root: firstId(headers['references']) || firstId(headers['in-reply-to']) || ownId,
				mailbox: at.label,
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

	return JSON.stringify({
		running: true, truncated: truncated, myAddresses: myAddresses, messages: messages,
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
