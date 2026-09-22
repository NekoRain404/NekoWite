/** The agent rail: the entry that starts, resumes or refuses a session. */
export const rail = {
  en: {
    /* The rail's own states, drawn by the shell around the panel: what it says while the
       engine is coming up, and what it offers when it did not. The two ways out are the
       rollback §12 asks for — ask again, or go back to the chat panel — and a refusal is shown
       in the backend's own sentence rather than summarised into one this file invented. */
    rail: {
      starting: 'Starting the agent engine...',
      noVault: 'The agent works inside one folder. Open a folder to use it.',
      refused: 'The agent engine could not be started.',
      retry: 'Try again',
      useChat: 'Back to the chat panel',
      unknownFailure: 'The request was refused without a reason this app could read.',
      stopFailed: 'The agent engine could not be stopped: {reason}',
      switchBusy: 'Stop active tasks and resolve pending permissions before switching agents.',
      /* A session the user picked out of the engine's history and the engine would not hand
         back. The rail keeps the session that is open — a failed load is not a reason to take a
         live conversation off the screen — so this sentence is the only place the refusal can be
         read, and it carries the engine's own reason rather than a summary of it. */
      resumeFailed: 'The session could not be reopened: {reason}',
      /* And the same for a session that never existed: the engine would not open one while it
         was already serving another. Nothing was taken away by the attempt — the session the
         reader was in is still open and still on screen — so this sentence is the only place
         the refusal can be read. */
      newSessionFailed: 'A new session could not be opened: {reason}',
      /* The pet's click on a task, when this window cannot put that session on screen
         (`app/pet-task-link.ts` decides that; `AppShell.vue`'s `taskUnavailableSentence` words
         these). Four sentences rather than one, because each names a different fact and a reason
         that is only sometimes true is not a reason: the engine is not running at all, it is
         still coming up, it is running for another folder, or it is running for this task's own
         folder under another engine. A click may not *start* one — that is the decision these
         sentences exist to state — so the refusal is what the reader gets instead of a session
         they did not ask for. The first and the last name the folder, which the pet's row never
         showed. */
      taskUnavailable: {
        noRuntime: 'The session this task belongs to is not open in this window: no agent engine is running here for {vault}.',
        starting: 'The session this task belongs to is not open in this window yet: the agent engine is still starting. Click the task again in a moment.',
        elsewhere: 'The session this task belongs to is not open in this window: this window is running its agent for {showing} instead.',
        otherEngine: 'The session this task belongs to is not open in this window: the agent running here for that folder is {engine}.',
      },
    },
  },
  zh: {
    rail: {
      starting: '正在启动智能体引擎……',
      noVault: '智能体在一个文件夹内工作。打开一个文件夹才能使用。',
      refused: '智能体引擎未能启动。',
      retry: '重试',
      useChat: '回到聊天面板',
      unknownFailure: '请求被拒绝，且没有给出本应用能读到的原因。',
      stopFailed: '智能体引擎未能停止：{reason}',
      switchBusy: '请先停止运行中的任务并处理待授权请求，再切换 Agent。',
      resumeFailed: '未能重新打开该会话：{reason}',
      newSessionFailed: '未能打开新会话：{reason}',
      taskUnavailable: {
        noRuntime: '这条任务所属的会话没有在这个窗口中打开：本窗口没有为该文件夹（{vault}）运行智能体引擎。',
        starting: '这条任务所属的会话还没有在这个窗口中打开：智能体引擎仍在启动。请稍后再点一次这条任务。',
        elsewhere: '这条任务所属的会话没有在这个窗口中打开：本窗口正在为 {showing} 运行智能体。',
        otherEngine: '这条任务所属的会话没有在这个窗口中打开：本窗口为该文件夹运行的是 {engine}。',
      },
    },
  },
} as const
