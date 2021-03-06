// Dependencies
import Telegraf, { ContextMessageUpdate, Extra } from 'telegraf'
import { strings } from './strings'
import {
  Candidate,
  findChatsWithCandidates,
  CaptchaType,
  Equation,
  removeMessages,
  Chat,
} from '../models'
import { bot } from './bot'
import { User, Message } from 'telegram-typings'
import { report } from './report'
import { ExtraReplyMessage } from 'telegraf/typings/telegram-types'
import { generateEquation } from './equation'
import { checkCAS } from './cas'
import { getImageCaptcha } from './captcha'
import { checkIfGroup } from '../middlewares/checkIfGroup'
import { modifyGloballyRestricted } from './globallyRestricted'
import { sendHelp } from '../commands/help'
import { modifyCandidates } from './candidates'
import { InstanceType } from 'typegoose'
import { modifyRestrictedUsers } from './restrictedUsers'
import { getUsername, getName } from './getUsername'

export function setupNewcomers(bot: Telegraf<ContextMessageUpdate>) {
  bot.on('new_chat_members', checkIfGroup, onNewChatMembers)
  // Check left messages
  bot.on('left_chat_member', async ctx => {
    // Delete left message if required
    if (ctx.dbchat.deleteEntryMessages || ctx.dbchat.underAttack) {
      try {
        await ctx.deleteMessage()
      } catch (err) {
        await report(err)
      }
    }
  })
  // Check newcomers
  bot.use(async (ctx, next) => {
    // Check if it the message is from a candidates with text
    if (
      !ctx.message ||
      !ctx.message.text ||
      !ctx.dbchat.candidates.length ||
      !ctx.dbchat.candidates.map(c => c.id).includes(ctx.from.id)
    ) {
      return next()
    }
    // Check if it is a button captcha (shouldn't get to this function then)
    if (ctx.dbchat.captchaType === CaptchaType.BUTTON) {
      // Delete message of restricted
      if (ctx.dbchat.strict) {
        try {
          await ctx.deleteMessage()
        } catch (err) {
          report(err, 'deleteMessage on button captcha')
        }
      }
      // Exit the function
      return next()
    }
    // Get candidate
    const candidate = ctx.dbchat.candidates
      .filter(c => c.id === ctx.from.id)
      .pop()
    // Check if it is digits captcha
    if (candidate.captchaType === CaptchaType.DIGITS) {
      // Check the format
      const hasCorrectAnswer = ctx.message.text.includes(
        candidate.equation.answer as string
      )
      const hasNoMoreThanTwoDigits =
        (ctx.message.text.match(/\d/g) || []).length <= 2
      if (!hasCorrectAnswer || !hasNoMoreThanTwoDigits) {
        if (ctx.dbchat.strict) {
          try {
            await ctx.deleteMessage()
          } catch (err) {
            await report(err, 'deleteMessage on digits captcha')
          }
        }
        return next()
      }
      // Delete message to decrease the amount of messages left
      try {
        await ctx.deleteMessage()
      } catch (err) {
        report(err, 'deleteMessage on passed digits captcha')
      }
    }
    // Check if it is image captcha
    if (candidate.captchaType === CaptchaType.IMAGE) {
      const hasCorrectAnswer = ctx.message.text.includes(candidate.imageText)
      if (!hasCorrectAnswer) {
        if (ctx.dbchat.strict) {
          try {
            await ctx.deleteMessage()
          } catch (err) {
            await report(err, 'deleteMessage on image captcha')
          }
        }
        return next()
      }
      // Delete message to decrease the amount of messages left
      try {
        await ctx.deleteMessage()
      } catch (err) {
        report(err, 'deleteMessage on passed image captcha')
      }
    }
    // Passed the captcha, delete from candidates
    await modifyCandidates(ctx.dbchat, false, [candidate])
    // Delete the captcha message
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, candidate.messageId)
    } catch (err) {
      await report(err, 'deleteCaptchaMessage after captcha is passed')
    }
    // Greet user
    await greetUser(ctx)
    return next()
  })
  // Check button
  bot.action(/\d+~\d+/, async ctx => {
    // Get user id and chat id
    const params = ctx.callbackQuery.data.split('~')
    const userId = parseInt(params[1])
    // Check if button is pressed by the candidate
    if (userId !== ctx.from.id) {
      try {
        await ctx.answerCbQuery(strings(ctx.dbchat, 'only_candidate_can_reply'))
      } catch (err) {
        await report(err)
      }
      return
    }
    // Check if this user is within candidates
    if (!ctx.dbchat.candidates.map(c => c.id).includes(userId)) {
      return
    }
    // Get the candidate
    const candidate = ctx.dbchat.candidates.filter(c => c.id === userId).pop()
    // Remove candidate from the chat
    await modifyCandidates(ctx.dbchat, false, [candidate])
    // Delete the captcha message
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, candidate.messageId)
    } catch (err) {
      await report(err)
    }
    // Greet the user
    await greetUser(ctx)
  })
}

async function onNewChatMembers(ctx: ContextMessageUpdate) {
  // Get list of ids
  const memberIds = ctx.message.new_chat_members.map(m => m.id)
  // Add to globaly restricted list
  await modifyGloballyRestricted(true, memberIds)
  // Start the newcomers logic
  try {
    // Get admin ids
    const adminIds = (await ctx.getChatAdministrators()).map(u => u.user.id)
    // If an admin adds the members, do nothing
    if (adminIds.includes(ctx.message.from.id)) {
      return
    }
    // Send help message if added this bot to the group
    const addedUsernames = ctx.message.new_chat_members
      .map(member => member.username)
      .filter(username => !!username)
    if (addedUsernames.includes(bot.options.username)) {
      try {
        await sendHelp(ctx)
      } catch (err) {
        report(err)
      }
    }
    // Filter new members
    const membersToCheck = ctx.message.new_chat_members.filter(
      m => !adminIds.includes(m.id) && !m.is_bot
    )
    // Placeholder to add all candidates in batch
    const candidatesToAdd = [] as Candidate[]
    // Loop through the members
    for (const member of membersToCheck) {
      // Delete all messages that they've sent yet
      removeMessages(ctx.chat.id, member.id) // don't await here
      // Check if under attack
      if (ctx.dbchat.underAttack) {
        await kickChatMember(ctx.dbchat, member)
        try {
          await ctx.deleteMessage()
        } catch (err) {
          await report(err)
        }
        continue
      }
      // Check if CAS banned
      if (!(await checkCAS(member.id))) {
        await kickChatMember(ctx.dbchat, member)
        continue
      }
      // Generate captcha if required
      const { equation, image } = await generateEquationOrImage(ctx.dbchat)
      // Notify candidate and save the message
      let message
      try {
        message = await notifyCandidate(ctx, member, equation, image)
      } catch (err) {
        await report(err)
      }
      // Create a candidate
      const candidate = getCandidate(ctx, member, message, equation, image)
      // Restrict candidate if required
      if (ctx.dbchat.restrict) {
        await restrictChatMember(ctx.dbchat, member)
      }
      // Save candidate to the placeholder list
      candidatesToAdd.push(candidate)
    }
    // Add candidates to the list
    await modifyCandidates(ctx.dbchat, true, candidatesToAdd)
    // Restrict candidates if required
    await modifyRestrictedUsers(ctx.dbchat, true, candidatesToAdd)
    // Delete entry message if required
    if (ctx.dbchat.deleteEntryMessages) {
      try {
        await ctx.deleteMessage()
      } catch (err) {
        await report(err)
      }
    }
  } catch (err) {
    console.error('onNewChatMembers', err)
  } finally {
    // Remove from globaly restricted list
    await modifyGloballyRestricted(false, memberIds)
  }
}

async function kickChatMember(chat: InstanceType<Chat>, user: User) {
  // Try kicking the member
  try {
    await bot.telegram.kickChatMember(
      chat.id,
      user.id,
      chat.banUsers ? 0 : parseInt(`${new Date().getTime() / 1000 + 45}`)
    )
  } catch (err) {
    report(err)
  }
  // Remove from candidates
  await modifyCandidates(chat, false, [user])
  // Remove from restricted
  await modifyRestrictedUsers(chat, false, [user])
}

async function kickCandidates(
  chat: InstanceType<Chat>,
  candidates: Candidate[]
) {
  // Loop through candidates
  for (const candidate of candidates) {
    // Try kicking the candidate
    try {
      await bot.telegram.kickChatMember(
        chat.id,
        candidate.id,
        chat.banUsers ? 0 : parseInt(`${new Date().getTime() / 1000 + 45}`)
      )
    } catch (err) {
      report(err)
    }
    // Try deleting their entry messages
    if (chat.deleteEntryOnKick) {
      try {
        await bot.telegram.deleteMessage(
          candidate.entryChatId,
          candidate.entryMessageId
        )
      } catch (err) {
        // do nothing
      }
    }
    // Try deleting the captcha message
    try {
      await bot.telegram.deleteMessage(chat.id, candidate.messageId)
    } catch (err) {
      await report(err, 'deleteMessage')
    }
  }
  // Remove from candidates
  await modifyCandidates(chat, false, candidates)
  // Remove from restricted
  await modifyRestrictedUsers(chat, false, candidates)
}

async function restrictChatMember(chat: InstanceType<Chat>, user: User) {
  try {
    const gotUser = (await bot.telegram.getChatMember(chat.id, user.id)) as any
    if (
      gotUser.can_send_messages &&
      gotUser.can_send_media_messages &&
      gotUser.can_send_other_messages &&
      gotUser.can_add_web_page_previews
    ) {
      const tomorrow = (new Date().getTime() + 24 * 60 * 60 * 1000) / 1000
      await (bot.telegram as any).restrictChatMember(chat.id, user.id, {
        until_date: tomorrow,
        can_send_messages: true,
        can_send_media_messages: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
      })
    }
  } catch (err) {
    await report(err)
  }
}

async function generateEquationOrImage(chat: InstanceType<Chat>) {
  const equation =
    chat.captchaType === CaptchaType.DIGITS ? generateEquation() : undefined
  const image =
    chat.captchaType === CaptchaType.IMAGE ? await getImageCaptcha() : undefined
  return { equation, image } as {
    equation?: Equation
    image?: { png: any; text: string }
  }
}

function getCandidate(
  ctx: ContextMessageUpdate,
  user: User,
  notificationMessage?: Message,
  equation?: Equation,
  image?: {
    png: any
    text: string
  }
): Candidate {
  return {
    id: user.id,
    timestamp: new Date().getTime(),
    captchaType: ctx.dbchat.captchaType,
    messageId: notificationMessage ? notificationMessage.message_id : undefined,
    equation,
    entryChatId: ctx.chat.id,
    entryMessageId: ctx.message.message_id,
    imageText: image ? image.text : undefined,
  }
}

async function notifyCandidate(
  ctx: ContextMessageUpdate,
  candidate: User,
  equation?: Equation,
  image?: { png: Buffer; text: string }
) {
  const chat = ctx.dbchat
  const warningMessage = strings(chat, `${chat.captchaType}_warning`)
  const extra =
    chat.captchaType !== CaptchaType.BUTTON
      ? Extra.webPreview(false)
      : Extra.webPreview(false).markup(m =>
          m.inlineKeyboard([
            m.callbackButton(
              strings(chat, 'captcha_button'),
              `${chat.id}~${candidate.id}`
            ),
          ])
        )
  if (
    chat.customCaptchaMessage &&
    chat.captchaMessage &&
    (chat.captchaType !== CaptchaType.DIGITS ||
      chat.captchaMessage.message.text.includes('$equation'))
  ) {
    const text = chat.captchaMessage.message.text
    if (
      text.includes('$username') ||
      text.includes('$title') ||
      text.includes('$equation') ||
      text.includes('$seconds') ||
      text.includes('$fullname')
    ) {
      const textToSend = text
        .replace(/\$username/g, getUsername(candidate))
        .replace(/\$fullname/g, getName(candidate))
        .replace(/\$title/g, (await ctx.getChat()).title)
        .replace(/\$equation/g, equation ? (equation.question as string) : '')
        .replace(/\$seconds/g, `${chat.timeGiven}`)
      if (image) {
        return ctx.replyWithPhoto({ source: image.png } as any, {
          caption: textToSend,
          parse_mode: 'Markdown',
        })
      } else {
        return ctx.telegram.sendMessage(
          chat.id,
          textToSend,
          extra as ExtraReplyMessage
        )
      }
    } else {
      const message = chat.captchaMessage.message
      message.text = `${getUsername(candidate)}\n\n${message.text}`
      return ctx.telegram.sendCopy(chat.id, message, extra as ExtraReplyMessage)
    }
  } else {
    if (image) {
      return ctx.replyWithPhoto({ source: image.png } as any, {
        caption: `[${getUsername(candidate)}](tg://user?id=${
          candidate.id
        })${warningMessage} (${chat.timeGiven} ${strings(chat, 'seconds')})`,
        parse_mode: 'Markdown',
      })
    } else {
      return ctx.replyWithMarkdown(
        `${
          chat.captchaType === CaptchaType.DIGITS
            ? `(${equation.question}) `
            : ''
        }[${getUsername(candidate)}](tg://user?id=${
          candidate.id
        })${warningMessage} (${chat.timeGiven} ${strings(chat, 'seconds')})`,
        extra
      )
    }
  }
}

async function greetUser(ctx: ContextMessageUpdate) {
  try {
    if (ctx.dbchat.greetsUsers && ctx.dbchat.greetingMessage) {
      const text = ctx.dbchat.greetingMessage.message.text
      let message
      if (
        text.includes('$username') ||
        text.includes('$title') ||
        text.includes('$fullname')
      ) {
        message = await ctx.telegram.sendMessage(
          ctx.dbchat.id,
          text
            .replace(/\$username/g, getUsername(ctx.from))
            .replace(/\$title/g, (await ctx.getChat()).title)
            .replace(/\$fullname/g, getName(ctx.from)),
          Extra.webPreview(false) as ExtraReplyMessage
        )
      } else {
        const msg = ctx.dbchat.greetingMessage.message
        msg.text = `${msg.text}\n\n${getUsername(ctx.from)}`
        message = await ctx.telegram.sendCopy(
          ctx.dbchat.id,
          msg,
          Extra.webPreview(false) as ExtraReplyMessage
        )
      }
      // Delete greeting message if requested
      if (ctx.dbchat.deleteGreetingTime && message) {
        setTimeout(async () => {
          try {
            await ctx.telegram.deleteMessage(
              message.chat.id,
              message.message_id
            )
          } catch (err) {
            // Do nothing
          }
        }, ctx.dbchat.deleteGreetingTime * 1000)
      }
    }
  } catch (err) {
    await report(err)
  }
}

// Check if needs to ban
setInterval(async () => {
  if (!checking) {
    check()
  }
}, 15 * 1000)

let checking = false
async function check() {
  checking = true
  try {
    const chats = await findChatsWithCandidates()
    for (const chat of chats) {
      // Check candidates
      const candidatesToDelete = []
      for (const candidate of chat.candidates) {
        if (
          new Date().getTime() - candidate.timestamp <
          chat.timeGiven * 1000
        ) {
          continue
        }
        candidatesToDelete.push(candidate)
      }
      try {
        await kickCandidates(chat, candidatesToDelete)
      } catch (err) {
        report(err, 'kickCandidatesAfterCheck')
      }
      // Check restricted users
      const restrictedToDelete = []
      for (const candidate of chat.restrictedUsers) {
        if (new Date().getTime() - candidate.timestamp > 24 * 60 * 60 * 1000) {
          restrictedToDelete.push(candidate)
        }
      }
      try {
        await modifyRestrictedUsers(chat, false, restrictedToDelete)
      } catch (err) {
        report(err, 'removeRestrictAfterCheck')
      }
    }
  } catch (err) {
    report(err, 'checking candidates')
  } finally {
    checking = false
  }
}
