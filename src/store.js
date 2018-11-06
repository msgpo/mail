import _ from 'lodash'
import Vue from 'vue'
import Vuex from 'vuex'
import {translate as t} from 'nextcloud-server/dist/l10n'

import {
	create as createAccount,
	fetch as fetchAccount,
	fetchAll as fetchAllAccounts
} from './service/AccountService'
import {fetchAll as fetchAllFolders,} from './service/FolderService'
import {
	deleteMessage,
	fetchEnvelopes,
	fetchMessage,
	setEnvelopeFlag,
	syncEnvelopes,
} from './service/MessageService'
import {showNewMessagesNotification} from './service/NotificationService'
import {parseUid} from './util/EnvelopeUidParser'

Vue.use(Vuex)

export const mutations = {
	addAccount (state, account) {
		account.folders = []
		account.collapsed = true
		Vue.set(state.accounts, account.id, account)
	},
	toggleAccountCollapsed (state, accountId) {
		state.accounts[accountId].collapsed = !state.accounts[accountId].collapsed
	},
	addFolder (state, {account, folder}) {
		let id = account.id + '-' + folder.id
		folder.envelopes = []
		Vue.set(state.folders, id, folder)
		account.folders.push(id)
	},
	updateFolderSyncToken (state, {folder, syncToken}) {
		folder.syncToken = syncToken
	},
	addEnvelope (state, {accountId, folder, envelope}) {
		const uid = accountId + '-' + folder.id + '-' + envelope.id
		const insert = folder => {
			Vue.set(
				folder,
				'envelopes',
				_.sortedUniq(
					_.orderBy(
						folder.envelopes.concat([uid]),
						id => state.envelopes[id].dateInt,
						'desc'
					)
				)
			)
		}

		envelope.accountId = accountId
		envelope.folderId = folder.id
		envelope.uid = uid
		Vue.set(state.envelopes, uid, envelope)
		insert(folder)
	},
	addUnifiedEnvelopes (state, {folder, envelopes}) {
		Vue.set(folder, 'envelopes', envelopes.map(e => e.uid))
	},
	flagEnvelope (state, {envelope, flag, value}) {
		envelope.flags[flag] = value
	},
	removeEnvelope (state, {accountId, folder, id}) {
		const envelopeUid = accountId + '-' + folder.id + '-' + id
		const idx = folder.envelopes.indexOf(envelopeUid)
		if (idx < 0) {
			console.warn('envelope does not exist', accountId, folder.id, id)
			return
		}
		folder.envelopes.splice(idx, 1)
		Vue.delete(folder.envelopes, envelopeUid)
	},
	addMessage (state, {accountId, folderId, message}) {
		const uid = accountId + '-' + folderId + '-' + message.id
		message.accountId = accountId
		message.folderId = folderId
		message.uid = uid
		Vue.set(state.messages, uid, message)
	},
	removeMessage (state, {accountId, folderId, id}) {
		Vue.delete(state.messages, accountId + '-' + folderId + '-' + id)
	}
}

export const actions = {
	fetchAccounts ({commit}) {
		return fetchAllAccounts().then(accounts => {
			accounts.forEach(account => commit('addAccount', account))
			return accounts
		})
	},
	fetchAccount ({commit}, id) {
		return fetchAccount(id).then(account => {
			commit('addAccount', account)
			return account
		})
	},
	createAccount ({commit}, config) {
		return createAccount(config)
			.then(account => {
				console.debug('account created', account)
				commit('addAccount', account)
				return account
			})
	},
	fetchFolders ({commit, getters}, {accountId}) {
		return fetchAllFolders(accountId).then(folders => {
			let account = getters.getAccount(accountId)

			folders.forEach(folder => {
				commit('addFolder', {
					account,
					folder
				})
			})
			return folders
		})
	},
	fetchEnvelopes ({state, commit, getters, dispatch}, {accountId, folderId}) {
		const folder = getters.getFolder(accountId, folderId)
		if (folder.isUnified) {
			return Promise.all(
				getters.getAccounts()
					.filter(account => !account.isUnified)
					.map(account => Promise.all(
						getters.getFolders(account.id)
							.filter(f => f.specialRole === folder.specialRole)
							.map(folder => dispatch('fetchEnvelopes', {
								accountId: account.id,
								folderId: folder.id,
							})))
					)
			)
				.then(res => _.flattenDepth(res, 2))
				.then(envs => _.orderBy(
					envs,
					env => env.dateInt,
					'desc'
				))
				.then(envs => _.slice(envs, 0, 20))
				.then(envelopes => commit('addUnifiedEnvelopes', {
					folder,
					envelopes,
				}))
		}

		return fetchEnvelopes(accountId, folderId).then(envs => {
			let folder = getters.getFolder(accountId, folderId)

			envs.forEach(envelope => commit('addEnvelope', {
				accountId,
				folder,
				envelope
			}))
			return envs
		})
	},
	fetchNextEnvelopePage ({commit, getters}, {accountId, folderId}) {
		const folder = getters.getFolder(accountId, folderId)
		const lastEnvelopeId = folder.envelopes[folder.envelopes.length - 1]
		if (typeof lastEnvelopeId === 'undefined') {
			console.error('folder is empty', folder.envelopes)
			return Promise.reject(new Error('Local folder has no envelopes, cannot determine cursor'))
		}
		const lastEnvelope = getters.getEnvelopeById(lastEnvelopeId)
		if (typeof lastEnvelope === 'undefined') {
			return Promise.reject(new Error('Cannot find last envelope. Required for the folder cursor'))
		}

		console.debug('loading next envelope page, cursor=' + lastEnvelope.dateInt)

		return fetchEnvelopes(accountId, folderId, lastEnvelope.dateInt).then(envs => {
			console.debug('page loaded, size=' + envs.length)

			envs.forEach(envelope => commit('addEnvelope', {
				accountId,
				folder,
				envelope
			}))

			return envs
		})
	},
	syncEnvelopes ({commit, getters, dispatch}, {accountId, folderId}) {
		const folder = getters.getFolder(accountId, folderId)

		if (folder.isUnified) {
			return Promise.all(
				getters.getAccounts()
					.filter(account => !account.isUnified)
					.map(account => Promise.all(
						getters.getFolders(account.id)
							.filter(f => f.specialRole === folder.specialRole)
							.map(folder => dispatch('syncEnvelopes', {
								accountId: account.id,
								folderId: folder.id,
							})))
					)
			)
		}

		const syncToken = folder.syncToken
		const uids = getters.getEnvelopes(accountId, folderId).map(env => env.id)

		return syncEnvelopes(accountId, folderId, syncToken, uids).then(syncData => {
			console.debug('got sync response:', syncData)
			syncData.newMessages.concat(syncData.changedMessages).forEach(envelope => {
				commit('addEnvelope', {
					accountId,
					folder,
					envelope
				})
			})
			syncData.vanishedMessages.forEach(envelope => {
				commit('removeEnvelope', {
					accountId,
					folder,
					id: envelope.id
				})
			})
			commit('updateFolderSyncToken', {
				folder,
				syncToken: syncData.token
			})

			return syncData.newMessages
		})
	},
	syncInboxes ({getters, dispatch}) {
		console.debug('syncing all inboxes')
		return Promise.all(getters.getAccounts()
			.filter(a => !a.isUnified)
			.map(account => {
				return Promise.all(getters.getFolders(account.id).map(folder => {
					if (folder.specialRole !== 'inbox') {
						return
					}

					return dispatch('syncEnvelopes', {
						accountId: account.id,
						folderId: folder.id,
					})
				}))
			}))
			.then(results => {
				console.debug('synced all inboxes successfully')

				const newMessages = _.flatMapDeep(results).filter(_.negate(_.isUndefined))
				if (newMessages.length > 0) {
					showNewMessagesNotification(newMessages)
				}
			})
	},
	toggleEnvelopeFlagged ({commit, getters}, envelope) {
		// Change immediately and switch back on error
		const oldState = envelope.flags.flagged
		commit('flagEnvelope', {
			envelope,
			flag: 'flagged',
			value: !oldState
		})

		setEnvelopeFlag(
			envelope.accountId,
			envelope.folderId,
			envelope.id,
			'flagged',
			!oldState
		).catch(e => {
			console.error('could not toggle message flagged state', e)

			// Revert change
			commit('flagEnvelope', {
				envelope,
				flag: 'flagged',
				value: oldState
			})
		})
	},
	toggleEnvelopeSeen ({commit, getters}, envelope) {
		// Change immediately and switch back on error
		const oldState = envelope.flags.unseen
		commit('flagEnvelope', {
			envelope,
			flag: 'unseen',
			value: !oldState
		})

		setEnvelopeFlag(
			envelope.accountId,
			envelope.folderId,
			envelope.id,
			'unseen',
			!oldState
		)
			.catch(e => {
				console.error('could not toggle message unseen state', e)

				// Revert change
				commit('flagEnvelope', {
					envelope,
					flag: 'unseen',
					value: oldState
				})
			})
	},
	fetchMessage ({commit}, uid) {
		const {accountId, folderId, id} = parseUid(uid)
		return fetchMessage(accountId, folderId, id).then(message => {
			commit('addMessage', {
				accountId,
				folderId,
				message
			})
			return message
		})
	},
	deleteMessage ({getters, commit}, envelope) {
		const folder = getters.getFolder(envelope.accountId, envelope.folderId)
		commit('removeEnvelope', {
			accountId: envelope.accountId,
			folder,
			id: envelope.id,
		})

		return deleteMessage(envelope.accountId, envelope.folderId, envelope.id)
			.then(() => {
				commit('removeMessage', {
					accountId: envelope.accountId,
					folder,
					id: envelope.id,
				})
				console.log('message removed')
			})
			.catch(err => {
				console.error('could not delete message', err)
				commit('addEnvelope', {
					accountId: envelope.accountId,
					folder,
					envelope,
				})
				throw err
			})
	}
}

export const getters = {
	getAccount: (state) => (id) => {
		return state.accounts[id]
	},
	getAccounts: (state) => () => {
		return _.sortBy(
			Object.keys(state.accounts).map(id => state.accounts[id]),
			account => account.id,
		)
	},
	getFolder: (state) => (accountId, folderId) => {
		return state.folders[accountId + '-' + folderId]
	},
	getFolders: (state) => (accountId) => {
		return state.accounts[accountId].folders.map(folderId => state.folders[folderId])
	},
	getEnvelope: (state) => (accountId, folderId, id) => {
		return state.envelopes[accountId + '-' + folderId + '-' + id]
	},
	getEnvelopeById: (state) => (id) => {
		return state.envelopes[id]
	},
	getEnvelopes: (state, getters) => (accountId, folderId) => {
		return getters.getFolder(accountId, folderId).envelopes.map(msgId => state.envelopes[msgId])
	},
	getMessage: (state) => (accountId, folderId, id) => {
		return state.messages[accountId + '-' + folderId + '-' + id]
	},
}

export default new Vuex.Store({
	strict: process.env.NODE_ENV !== 'production',
	state: {
		accounts: {
			0: {
				id: 0,
				isUnified: true,
				folders: ['0-inbox'],
				collapsed: false,
				emailAddress: '',
				name: ''
			},
		},
		folders: {
			'0-inbox': {
				id: 'inbox',
				isUnified: true,
				specialRole: 'inbox',
				name: t('mail', 'All inboxes'), // TODO,
				unread: 0,
				envelopes: [],
			}
		},
		envelopes: {},
		messages: {},
	},
	getters,
	mutations,
	actions
})
