# Appearance settings

Open **Settings → Appearance** to change these account preferences:

- **Animations** turns the Home sun's rotating rays and evening stars' twinkling
  on or off. Turning it off also stops interface transitions. The illustration
  stays visible when static.
- **Dark mode** switches between light and dark app colors, including budget
  fields, dialogs, goals, charts and warnings.

Both choices are stored inside the encrypted budget and follow the account when
it is unlocked on another device. The defaults are light colors and animations
enabled. Device/browser color and motion preferences do not control these switches.
Sign-in screens use the light palette before the encrypted account is unlocked.

The Home illustration follows the existing greeting times: morning from midnight
to 11:59 a.m., afternoon from noon to 4:59 p.m., and evening from 5 p.m. to
11:59 p.m. It uses the local clock, not location or weather data. It updates at
greeting boundaries and after returning to the page. Animation pauses while the
page is hidden; no animation uses a JavaScript frame loop or an external service.

The refreshed palette uses teal for main actions and savings, lavender for
Budgeted/payoff sections, and small amber accents. Negative amounts and warnings
keep distinct text/signs and contrasting colors. Print styling uses light
backgrounds and static illustrations. No API deployment or new Azure resource
is needed. Refresh older browser tabs after this release.
