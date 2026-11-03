// Aggregations for the dashboard's stats view.
//
// This is deliberately a pure function: the server reads the prototype
// workbook, then hands the transactions and expected monthly setup in here.
// Keeping it out of the route makes the chart data easy to reason about and
// lets the same shape be fed from Postgres later.

export type StatsPeriod = 'week' | 'month' | 'year';

export type StatsTransaction = {
    bucket: string;
    amount: number;
    spent_on: string;
    recurring: boolean;
};

export type StatsPoint = {
    start: string;
    end: string;
    label: string;
    total: number;
    recurring: number;
    oneTime: number;
    expected: number;
    difference: number;
};

export type StatsCategory = {
    bucket: string;
    label: string;
    actual: number;
    expected: number;
    difference: number;
};

export type StatsTotals = {
    actual: number;
    expected: number;
    difference: number;
    recurring: number;
    oneTime: number;
    recurringShare: number;
    transactionCount: number;
    budgetSource: 'big_picture' | 'monthly_setup';
};

export type PrototypeStats = {
    period: StatsPeriod;
    range: { start: string; end: string; label: string };
    series: StatsPoint[];
    categories: StatsCategory[];
    totals: StatsTotals;
};

export type BuildStatsInput = {
    period: StatsPeriod;
    transactions: StatsTransaction[];
    // Expected monthly amount per bucket, already normalised by the caller.
    expectedByBucket: Record<string, number>;
    // Total monthly budget from the Big Picture planner. Null means the
    // planner is not configured, so use the monthly setup total instead.
    bigPictureBudget?: number | null;
    labels: Record<string, string>;
    today?: Date;
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_PER_MONTH = 365.25 / 12;

type PointSeed = {
    start: Date;
    end: Date;
    startDay: string;
    endDay: string;
    label: string;
};

function localMidnight(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isoDay(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate()
    ).padStart(2, '0')}`;
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfWeek(date: Date): Date {
    const mondayOffset = (date.getDay() + 6) % 7;
    return addDays(localMidnight(date), -mondayOffset);
}

function startOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function daysInMonth(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function startOfYear(date: Date): Date {
    return new Date(date.getFullYear(), 0, 1);
}

function shortDate(date: Date): string {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function rangeLabel(period: StatsPeriod, first: Date, last: Date): string {
    if (period === 'week') {
        return `${shortDate(first)} – ${shortDate(last)}, ${last.getFullYear()}`;
    }
    if (period === 'month') {
        return first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    return String(first.getFullYear());
}

function pointSeeds(period: StatsPeriod, today: Date): PointSeed[] {
    const make = (start: Date, label: string): PointSeed => {
        const end = addDays(start, 1);
        return { start, end, startDay: isoDay(start), endDay: isoDay(end), label };
    };

    if (period === 'week') {
        const monday = startOfWeek(today);
        return Array.from({ length: 7 }, (_, index) => make(addDays(monday, index), WEEKDAYS[index] ?? ''));
    }

    if (period === 'month') {
        const first = startOfMonth(today);
        return Array.from({ length: daysInMonth(today) }, (_, index) =>
            make(new Date(first.getFullYear(), first.getMonth(), index + 1), String(index + 1))
        );
    }

    const first = startOfYear(today);
    return Array.from({ length: 12 }, (_, index) => {
        const start = new Date(first.getFullYear(), index, 1);
        const end = new Date(first.getFullYear(), index + 1, 1);
        return {
            start,
            end,
            startDay: isoDay(start),
            endDay: isoDay(end),
            label: start.toLocaleDateString('en-US', { month: 'short' }),
        };
    });
}

function round2(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function prettyKey(key: string): string {
    return key.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

export function buildPrototypeStats(input: BuildStatsInput): PrototypeStats {
    const today = input.today ?? new Date();
    const seeds = pointSeeds(input.period, today);
    const first = seeds[0];
    const last = seeds[seeds.length - 1];

    if (!first || !last) {
        throw new Error('Could not build a stats range.');
    }

    const setupMonthlyExpected = Object.values(input.expectedByBucket).reduce(
        (sum, amount) => sum + (Number.isFinite(amount) ? amount : 0),
        0
    );

    // The Big Picture budget is the total the Stats tab should compare against.
    // It can be negative when fixed calls and savings exceed income, but a chart
    // cannot draw a negative target, so treat that case as a zero budget.
    const hasBigPictureBudget =
        typeof input.bigPictureBudget === 'number' && Number.isFinite(input.bigPictureBudget);
    const monthlyExpected = hasBigPictureBudget
        ? Math.max(0, input.bigPictureBudget as number)
        : setupMonthlyExpected;
    const expectedScale =
        hasBigPictureBudget && setupMonthlyExpected > 0
            ? monthlyExpected / setupMonthlyExpected
            : 1;

    // A week is a slice of a month; a month is one monthly setup; a year is
    // twelve of them.
    const periodFactor =
        input.period === 'week' ? 7 / DAYS_PER_MONTH : input.period === 'year' ? 12 : 1;
    const totalExpected = round2(monthlyExpected * periodFactor);
    const expectedPerPoint = totalExpected / seeds.length;

    const series: StatsPoint[] = seeds.map(seed => ({
        start: seed.startDay,
        end: seed.endDay,
        label: seed.label,
        total: 0,
        recurring: 0,
        oneTime: 0,
        expected: round2(expectedPerPoint),
        difference: 0,
    }));

    const categoryActual = new Map<string, number>();
    let actual = 0;
    let recurring = 0;
    let oneTime = 0;
    let transactionCount = 0;

    for (const transaction of input.transactions) {
        const day = String(transaction.spent_on).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;

        const index = seeds.findIndex(seed => day >= seed.startDay && day < seed.endDay);
        if (index < 0) continue;

        const amount = Number(transaction.amount);
        if (!Number.isFinite(amount)) continue;

        const point = series[index];
        if (!point) continue;

        point.total += amount;
        if (transaction.recurring) {
            point.recurring += amount;
            recurring += amount;
        } else {
            point.oneTime += amount;
            oneTime += amount;
        }

        const bucket = String(transaction.bucket);
        categoryActual.set(bucket, (categoryActual.get(bucket) ?? 0) + amount);
        actual += amount;
        transactionCount += 1;
    }

    for (const point of series) {
        point.total = round2(point.total);
        point.recurring = round2(point.recurring);
        point.oneTime = round2(point.oneTime);
        point.difference = round2(point.total - point.expected);
    }

    const bucketKeys = new Set([
        ...Object.keys(input.expectedByBucket),
        ...categoryActual.keys(),
    ]);

    const categories = Array.from(bucketKeys)
        .map(bucket => {
            const expected = round2(
                (input.expectedByBucket[bucket] ?? 0) * expectedScale * periodFactor
            );
            const spent = round2(categoryActual.get(bucket) ?? 0);
            return {
                bucket,
                label: input.labels[bucket] ?? prettyKey(bucket),
                actual: spent,
                expected,
                difference: round2(spent - expected),
            };
        })
        .filter(category => category.actual > 0 || category.expected > 0)
        .sort(
            (a, b) =>
                b.expected + b.actual - (a.expected + a.actual) || a.label.localeCompare(b.label)
        );

    const roundedActual = round2(actual);
    const roundedRecurring = round2(recurring);

    return {
        period: input.period,
        range: {
            start: first.startDay,
            end: last.endDay,
            label: rangeLabel(input.period, first.start, addDays(last.end, -1)),
        },
        series,
        categories,
        totals: {
            actual: roundedActual,
            expected: totalExpected,
            difference: round2(roundedActual - totalExpected),
            recurring: roundedRecurring,
            oneTime: round2(oneTime),
            recurringShare: roundedActual > 0 ? roundedRecurring / roundedActual : 0,
            transactionCount,
            budgetSource: hasBigPictureBudget ? 'big_picture' : 'monthly_setup',
        },
    };
}
