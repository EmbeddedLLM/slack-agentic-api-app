import 'dotenv/config';
import { TeamsAuth } from '../src/teams-auth.js';

const auth = new TeamsAuth();
const command = process.argv[2];
try {
  if (auth.config.mode === 'per_user' && ['login', 'status', 'logout'].includes(command)) {
    if (command !== 'logout') auth.validate();
    if (command === 'status') {
      console.log(`Teams configuration: OK\nOrganizer: each Slack requester\nTool enabled: ${auth.config.enabled ? 'yes' : 'no (set TEAMS_ENABLED=true)'}`);
      console.log('Each member signs in privately when requesting a meeting. No meeting was created.');
    } else {
      console.log(command === 'login' ? 'Ask Meow-AI in Slack to create a Teams meeting. It will send you private Microsoft sign-in instructions when needed.' : 'To remove your own Microsoft sign-in, send @Meow-AI teams disconnect in Slack.');
      console.log('The terminal login/logout commands manage an organizer only when TEAMS_ORGANIZER_MODE=shared.');
    }
  } else if (command === 'login') {
    console.log('Sign in with the shared Teams work/school organizer account. Stop the bot before signing in.');
    const account = await auth.login(({ uri, code }) => console.log(`Open ${uri} and enter code: ${code}`));
    console.log(`Teams organizer connected: ${account.username || '(work/school account)'}. Set TEAMS_ENABLED=true and restart the bot.`);
  } else if (command === 'status') {
    auth.validate();
    const { organizer } = await auth.token();
    console.log(`Teams organizer: ${organizer.username || '(work/school account)'}\nSilent sign-in: OK\nTool enabled: ${auth.ready() ? 'yes' : 'no (set TEAMS_ENABLED=true)'}`);
    console.log('No meeting was created. Graph meeting permissions and the Teams license are checked when a meeting is requested.');
  } else if (command === 'logout') {
    auth.logout();
    console.log('Local Microsoft credentials removed. Existing meetings are unchanged. Revoke the app consent in Microsoft to revoke its access there.');
  } else throw new Error('Usage: node scripts/teams-auth.js login|status|logout');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
