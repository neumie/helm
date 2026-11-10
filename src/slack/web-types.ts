// Minimal shapes of the Slack Web API responses Helm reads. Everything is optional: this is parsed
// JSON from an undocumented client surface, never trusted; the mapping re-checks every field.

export interface SlackAuthTest {
	user_id?: string
	user?: string
	team_id?: string
	team?: string
	url?: string
}

export interface SlackConversation {
	id?: string
	is_im?: boolean
	is_mpim?: boolean
	is_private?: boolean
	is_archived?: boolean
	is_user_deleted?: boolean
	user?: string // the other user id for an IM
	name?: string
	last_read?: string
	unread_count_display?: number
	latest?: SlackMessage
}

export interface SlackMessage {
	type?: string
	subtype?: string
	user?: string
	bot_id?: string
	text?: string
	ts?: string
	thread_ts?: string
	parent_user_id?: string
	subscribed?: boolean
	last_read?: string
	reply_count?: number
}

export interface SlackConversationsList {
	channels?: SlackConversation[]
	response_metadata?: { next_cursor?: string }
}

export interface SlackConversationInfo {
	channel?: SlackConversation
}

export interface SlackRepliesResponse {
	messages?: SlackMessage[]
	has_more?: boolean
	response_metadata?: { next_cursor?: string }
}

export interface SlackSearchMatch {
	type?: string
	user?: string
	username?: string
	text?: string
	ts?: string
	permalink?: string
	channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean }
}

export interface SlackSearchResponse {
	messages?: { matches?: SlackSearchMatch[]; paging?: { pages?: number; page?: number }; total?: number }
}

export interface SlackUser {
	id?: string
	name?: string
	real_name?: string
	is_bot?: boolean
	deleted?: boolean
	profile?: { display_name?: string; real_name?: string }
}

export interface SlackUserInfo {
	user?: SlackUser
}

export interface SlackChatPostMessage {
	ok?: boolean
	ts?: string
	channel?: string
}

export interface SlackConversationOpen {
	channel?: { id?: string }
}
