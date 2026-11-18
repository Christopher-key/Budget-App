import { useEffect, useState } from 'react';
import './sky.css';

/** Keep the greeting current without waking the page between greeting changes. */
export function useGreetingHour(): number {
  const [hour, setHour] = useState(() => new Date().getHours());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    const updateAndSchedule = () => {
      clearTimer();
      if (document.hidden) return;

      const now = new Date();
      const currentHour = now.getHours();
      setHour(currentHour);
      const nextChange = new Date(now);
      nextChange.setHours(currentHour < 12 ? 12 : currentHour < 17 ? 17 : 24, 0, 0, 0);
      timer = setTimeout(updateAndSchedule, nextChange.getTime() - now.getTime());
    };

    const onVisibilityChange = () => {
      if (document.hidden) clearTimer();
      else updateAndSchedule();
    };

    updateAndSchedule();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return hour;
}

export function TimeOfDayAccent({ hour, animate }: { hour: number; animate: boolean }) {
  const [hidden, setHidden] = useState(() => document.hidden);
  const phase = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const night = hour >= 17;

  useEffect(() => {
    const onVisibilityChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  return <div className={`sky-accent ${night ? 'sky-accent--night' : 'sky-accent--day'}`} data-animated={animate} data-paused={hidden}>
    <div className="sky-illustration" role="img" aria-label={`${phase} sky with ${night ? 'a crescent moon and stars' : 'sunshine'}`}>
      <svg width="80" height="80" viewBox="0 0 80 80" aria-hidden="true" focusable="false">
        {night ? <>
          <circle className="sky-night-wash" cx="35" cy="35" r="29"/>
          <path className="sky-moon" d="M45 11a24 24 0 1 0 13 39A24 24 0 0 1 45 11Z"/>
          <path className="sky-star sky-star--first" d="m60 9 1.7 4.3L66 15l-4.3 1.7L60 21l-1.7-4.3L54 15l4.3-1.7Z"/>
          <path className="sky-star sky-star--second" d="m69 31 1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1Z"/>
          <circle className="sky-star sky-star--third" cx="18" cy="11" r="1.6"/>
          <path className="sky-horizon" d="M12 69h24m5 0h6"/>
        </> : <>
          <circle className="sky-day-wash" cx="35" cy="33" r="29"/>
          <g className="sky-sun-rays">
            <path d="M35 6v6m0 42v6M8 33h6m42 0h6M15.9 13.9l4.2 4.2m29.8 29.8 4.2 4.2m-38.2 0 4.2-4.2m29.8-29.8 4.2-4.2"/>
          </g>
          <circle className="sky-sun" cx="35" cy="33" r="16"/>
          <path className="sky-sun-glint" d="M28 25a10 10 0 0 1 7-3"/>
          <path className="sky-horizon" d="M12 69h24m5 0h6"/>
        </>}
      </svg>
    </div>
  </div>;
}
