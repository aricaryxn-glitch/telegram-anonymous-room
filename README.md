# Telegram Anonymous Room

Private Telegram bot for an anonymous five-person room.

## What it does

- Each person opens the bot and sends `/start`.
- The bot asks for their unique password.
- The password message is deleted immediately after the bot checks it.
- Approved users can message the bot; the bot relays messages anonymously to everyone else.
- Relayed messages are protected from forwarding where Telegram supports it.
- Incoming and outgoing tracked messages are deleted after 1 hour.
- `/who` shows how many people are connected.
- `/leave` removes a person from the room.

## Setup

1. Create a bot in Telegram with BotFather and copy the token.
2. Double-click `Setup Bot.bat`.
3. Paste the BotFather token when asked.
4. Save the five generated passwords and give each person one.

Or run manually:

```powershell
npm install
copy .env.example .env
npm run generate-passwords -- 5
npm start
```

Give each person one generated password. Passwords are not stored in plain text.

## Run Locally

Double-click `Start Bot.bat`.

## Hosting

Deploy this folder to a Node host. Add these environment variables there:

```text
TELEGRAM_BOT_TOKEN
PASSWORD_PEPPER
ROOM_SIZE=5
MESSAGE_TTL_MS=3600000
PORT=3000
STATE_GITHUB_TOKEN
STATE_GITHUB_REPO=aricaryxn-glitch/telegram-anonymous-room-state
STATE_GITHUB_PATH=db.json
```

This folder includes `Procfile` and `render.yaml` for hosts such as Render.

After it is online, add this URL in UptimeRobot as an HTTP monitor:

```text
https://your-host-url.example/health
```

## Limits

Telegram bots can delete messages only within Telegram Bot API limits. This bot schedules deletion after 1 hour, which is inside Telegram's 48-hour delete window. If the host is asleep or offline at the deletion time, deletion happens when the bot wakes back up, provided Telegram still allows it.
