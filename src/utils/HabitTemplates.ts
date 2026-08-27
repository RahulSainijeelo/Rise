export type SensorType = 'pedometer' | 'screen' | 'noise' | 'movement' | 'gps';
/**
 * 'atLeast' (default) — you win by reaching the goal.
 * 'atMost'  — you win by staying under it. Completion cannot be inferred from
 *             progress alone, only committed when the window closes or the user
 *             confirms. See docs/WIDGET_CONTRACT.md.
 */
export type GoalDirection = 'atLeast' | 'atMost';

export type SunsetVerification = 'usagestats' | 'unlocks' | 'manual';

export interface HabitTemplate {
    id: string;
    title: string;
    description: string;
    type: 'check' | 'timer' | 'numeric';
    category: 'Health' | 'Productivity' | 'Mindset' | 'Bad Habit';
    color: string;
    icon: string;
    goal?: number;
    unit?: string;
    goalDirection?: GoalDirection;
    // Atomic Habit Laws
    cue: string;
    craving: string;
    response: string;
    reward: string;
    howToApply: string;
    // Sensor Information
    isSensorBased?: boolean;
    sensorType?: SensorType;
    requiredPermissions?: string[];
    /** Ambient dB at or below which a 'noise' habit's timer accrues. */
    noiseThresholdDb?: number;
    /** Start of a nightly window, 'HH:mm'. Used by 'screen' habits. */
    cutoffTime?: string;
    /** End of that window the following morning, 'HH:mm'. */
    windowEndTime?: string;
    /** Minutes of post-cutoff phone use still counted as a success. */
    allowanceMinutes?: number;
    sunsetVerification?: SunsetVerification;
}

export const COMMON_HABITS_TEMPLATES: HabitTemplate[] = [
    {
        id: 'water_habit',
        title: 'Drink Water',
        description: 'Stay hydrated for physical and mental clarity.',
        type: 'numeric',
        category: 'Health',
        color: '#60A5FA',
        icon: 'Droplets',
        goal: 8,
        unit: 'glasses',
        cue: 'Place a large water bottle on your desk every morning.',
        craving: 'Visualize the refreshing feeling of hydration and energy.',
        response: 'Take a sip every time you finish a task or check your phone.',
        reward: 'Tick off a glass in the app and feel the physical energy boost.',
        howToApply: 'Law 1: Make it obvious. Set the bottle in your line of sight.'
    },
    {
        id: 'sunlight_habit',
        title: 'Morning Sunlight',
        description: 'Sync your circadian rhythm with early morning light.',
        type: 'timer',
        category: 'Health',
        color: '#FBBF24',
        icon: 'Sun',
        goal: 600, // 10 mins
        cue: 'Open the blinds as soon as you wake up.',
        craving: 'The desire to feel awake and alert without needing caffeine immediately.',
        response: 'Step outside for 10 minutes right after your first glass of water.',
        reward: 'Enjoy the warmth on your face and the natural alertness.',
        howToApply: 'Law 2: Make it attractive. Combine it with your morning coffee.'
    },
    {
        id: 'meditation_habit',
        title: 'Meditation',
        description: 'Reduce stress and improve focus with daily mindfulness.',
        type: 'timer',
        category: 'Mindset',
        color: '#A78BFA',
        icon: 'Wind',
        goal: 600, // 10 mins
        cue: 'Sitting in your "meditation chair" immediately after brushing teeth.',
        craving: 'Longing for a moment of quiet in a loud world.',
        response: 'Use the Rise timer and focus on your breath for 10 minutes.',
        reward: 'Sense of calm and mental space for the day ahead.',
        howToApply: 'Law 3: Make it easy. Start with just 2 minutes if 10 feels hard.'
    },
    {
        id: 'no_phone_night',
        title: 'No Phone in Bed',
        description: 'Protect your sleep quality by avoiding blue light.',
        type: 'check',
        category: 'Bad Habit',
        color: '#EF4444',
        icon: 'SmartphoneNfc',
        cue: 'The phone charger is in the living room, not the bedroom.',
        craving: 'Wanting to doomscroll to avoid tomorrow\'s responsibilities.',
        response: 'Read a physical book instead when you get into bed.',
        reward: 'Falling asleep faster and waking up feeling rested.',
        howToApply: 'Inversion of Law 1: Make it invisible. Charge your phone away from bed.'
    },
    {
        id: 'read_habit',
        title: 'Read 10 Pages',
        description: 'Consistent reading compounds into massive knowledge.',
        type: 'numeric',
        category: 'Productivity',
        color: '#34D399',
        icon: 'BookOpen',
        goal: 10,
        unit: 'pages',
        cue: 'Leave your book on your pillow when you make the bed.',
        craving: 'The excitement of learning something new or getting lost in a story.',
        response: 'Read 10 pages before you go to sleep.',
        reward: 'The satisfaction of finishing chapters and growing smarter.',
        howToApply: 'Law 3: Make it easy. Use the "Two-Minute Rule"—just read one page to start.'
    },
    {
        id: 'walk_habit',
        title: '30m Daily Walk',
        description: 'Simple movement is the foundation of health.',
        type: 'timer',
        category: 'Health',
        color: '#10B981',
        icon: 'Footprints',
        goal: 1800, // 30 mins
        cue: 'Keep your walking shoes by the door.',
        craving: 'The need for fresh air after being indoors all day.',
        response: 'Walk for 30 minutes right after lunch.',
        reward: 'Lowered stress and better digestion.',
        howToApply: 'Law 1: Make it obvious. Set your shoes where you can\'t miss them.'
    },
    {
        id: 'step_legend',
        title: 'Step Legend',
        description: 'Commit to a daily step goal verified by your phone.',
        type: 'numeric',
        category: 'Health',
        color: '#FFFFFF',
        icon: 'Footprints',
        goal: 10000,
        unit: 'steps',
        isSensorBased: true,
        sensorType: 'pedometer',
        requiredPermissions: ['android.permission.ACTIVITY_RECOGNITION', 'ios.permission.MOTION'],
        cue: 'Check your current step count as soon as you finish breakfast.',
        craving: 'The urge to see that progress bar hit the 100% mark.',
        response: 'Take the stairs or go for a short walk to top up your count.',
        reward: 'The "Legendary" badge on your profile and genuine physical fatigue.',
        howToApply: 'Law 1: Make it obvious. Add the Rise Step Widget to your home screen.'
    },
    {
        id: 'digital_sunset',
        title: 'Digital Sunset',
        description: 'Keep phone use under 5 minutes between 22:00 and 06:00.',
        type: 'numeric',
        category: 'Bad Habit',
        color: '#FB7185',
        icon: 'Moon',
        // Inverse goal: the number counts *against* you. 5 minutes of grace so a
        // glance at the clock or a reply to one message does not void the night.
        goal: 5,
        unit: 'minutes',
        goalDirection: 'atMost',
        cutoffTime: '22:00',
        windowEndTime: '06:00',
        allowanceMinutes: 5,
        sunsetVerification: 'usagestats',
        isSensorBased: true,
        sensorType: 'screen',
        // PACKAGE_USAGE_STATS is a special access grant, not a runtime permission:
        // it cannot be requested with a dialog and must be opened in Settings.
        // Without it the habit falls back to counting unlocks, which needs nothing.
        requiredPermissions: ['android.permission.PACKAGE_USAGE_STATS'],
        cue: 'The clock hitting 22:00 and your phone auto-dimming.',
        craving: 'Resisting the "one last scroll" that steals your sleep.',
        response: 'Put the phone on the charger in another room until 06:00.',
        reward: 'Waking up without dry eyes and with a clear head.',
        howToApply: 'Law 3: Make it difficult. A physical separation from your device.'
    },
    {
        id: 'deep_silence',
        title: 'Deep Silence',
        description: 'Build focus by working in a truly quiet environment.',
        type: 'timer',
        category: 'Productivity',
        color: '#94A3B8',
        icon: 'VolumeX',
        goal: 3600, // 1 hour
        unit: 'seconds',
        noiseThresholdDb: 45,
        isSensorBased: true,
        sensorType: 'noise',
        requiredPermissions: ['android.permission.RECORD_AUDIO', 'ios.permission.MICROPHONE'],
        cue: 'Clearing your desk and putting your phone in "Silent".',
        craving: 'The feeling of "Flow" where time disappears.',
        response: 'Work for 60 minutes with noise levels below 45dB.',
        reward: 'Massive progress on your hardest tasks.',
        howToApply: 'Law 4: Make it satisfying. Watching the "Silence Meter" stay in the green.'
    },
    {
        id: 'immediate_rise',
        title: 'Immediate Rise',
        description: 'Defeat the snooze button by taking 60 steps on waking.',
        type: 'numeric',
        category: 'Health',
        color: '#38BDF8',
        icon: 'Zap',
        // Was a bare 'check' with no goal, so a single detected step completed it.
        // 60 steps is roughly the 50m walk the habit actually asks for.
        goal: 60,
        unit: 'steps',
        isSensorBased: true,
        sensorType: 'movement',
        requiredPermissions: ['android.permission.ACTIVITY_RECOGNITION', 'ios.permission.MOTION'],
        cue: 'Your alarm goes off at 7:00 AM.',
        craving: 'The instinct to hide under the covers for "5 more minutes".',
        response: 'Take 60 steps within 5 minutes of the alarm (verified by motion sensor).',
        reward: 'Being the first person to start the day in your household.',
        howToApply: 'Law 3: Make it easy. Place your robe and slippers right next to bed.'
    },
    {
        id: 'city_glider',
        title: 'City Glider',
        description: 'Choose active commuting over idle travel.',
        type: 'numeric',
        category: 'Health',
        color: '#4ADE80',
        icon: 'Bike',
        goal: 2,
        unit: 'km',
        isSensorBased: true,
        sensorType: 'gps',
        requiredPermissions: ['android.permission.ACCESS_FINE_LOCATION', 'ios.permission.LOCATION'],
        cue: 'Leaving the house for work or errands.',
        craving: 'Feeling the wind and noticing your surroundings.',
        response: 'Bike or walk 2km instead of taking a car or bus.',
        reward: 'Endorphin rush and a "Greener World" achievement.',
        howToApply: 'Law 4: Make it satisfying. Check the commute savings in your weekly report.'
    }
];

/** Look a template up by id. Returns undefined for hand-made habits. */
export const findTemplate = (templateId?: string): HabitTemplate | undefined =>
    templateId ? COMMON_HABITS_TEMPLATES.find(t => t.id === templateId) : undefined;

/**
 * Convert a template into the payload `addHabit` expects.
 *
 * Both places that create a habit from a template must go through this. They
 * used to build the object inline and each forgot different fields — neither
 * persisted `templateId`, which is what widgets bind on, and neither carried the
 * Digital Sunset window, so the habit had no goal at all once created.
 *
 * `goalOverride` is the value the user typed on the knowledge screen; it is
 * interpreted in the template's own unit (seconds for timers, the display unit
 * otherwise).
 */
export const habitFromTemplate = (
    template: HabitTemplate,
    goalOverride?: number,
    fallbackColor?: string
) => {
    const goal = (Number.isFinite(goalOverride) && (goalOverride as number) > 0)
        ? (goalOverride as number)
        : template.goal;

    return {
        templateId: template.id,
        title: template.title,
        description: template.description,
        frequency: 'daily' as const,
        type: template.type,
        timerGoal: template.type === 'timer' ? goal : undefined,
        numericGoal: template.type === 'numeric' ? goal : undefined,
        numericUnit: template.unit,
        goalDirection: template.goalDirection || 'atLeast',
        reminders: [] as string[],
        color: template.color || fallbackColor,
        cue: template.cue,
        craving: template.craving,
        response: template.response,
        reward: template.reward,
        howToApply: template.howToApply,
        isSensorBased: template.isSensorBased,
        sensorType: template.sensorType,
        requiredPermissions: template.requiredPermissions,
        noiseThresholdDb: template.noiseThresholdDb,
        // Sunset window. Carried even when undefined so that editing a habit
        // later can distinguish "never configured" from "explicitly cleared".
        cutoffTime: template.cutoffTime,
        windowEndTime: template.windowEndTime,
        allowanceMinutes: template.allowanceMinutes,
        sunsetVerification: template.sunsetVerification,
    };
};
