// Pure computation for the prototype dashboard.
//
// Both backends (MongoDB in normal mode, the xlsx workbook in demo mode) read
// and write their own storage, then hand the same normalised rows in here.
// Keeping the maths in one place is what stops the two stores drifting apart.

import {
    BUCKET_DETAIL_FIELDS,
    BUCKET_LABELS,
    FORM_BUCKETS,
    bucketAverage,
    bucketWeight,
    transactionWeight,
} from './expense_categories';

export type Row = Record<string, unknown>;
export type Frequency = 'monthly' | 'yearly' | 'weekly';

export type ExpenseRow = {
    category: string;
    amount: number;
    frequency: Frequency;
    detail: Row;
    updated_at: Date | string | null;
};

export type BigPictureRow = {
    category: string;
    amount: number;
    frequency: Frequency;
    updated_at: Date | string | null;
};

export type TransactionRow = {
    transaction_id: string | number;
    category: string;
    bucket: string;
    amount: number;
    spent_on: string;
    note: string;
    recurring: boolean;
    created_at: Date | string | null;
};

export type ProfileHeader = {
    profile_key: string;
    display_name: string;
    updated_at: Date | string | null;
};

export type ProfileData = {
    profile: ProfileHeader | null;
    expenses: ExpenseRow[];
    transactions: TransactionRow[];
    bigPicture: BigPictureRow[];
};

export type PrototypeMode = 'mongo' | 'demo';

export type MonthlySetupEntry = {
    bucket: string;
    amount: number;
    frequency: Frequency;
};

export type BigPictureEntry = {
    category: string;
    amount: number;
    frequency: Frequency;
};

export type NewTransaction = {
    category: string;
    bucket: string;
    amount: number;
    spentOn: string;
    note: string;
    recurring: boolean;
};

// One place for the bucket metadata. The dashboard reads label + detailFields,
// and the assessment page gets its own copy from /api/expense-weights.
export const BUCKETS = Object.entries(BUCKET_LABELS).map(([bucket, label]) => ({
    bucket,
    label,
    categories: FORM_BUCKETS[bucket] ?? [],
    weight: bucketWeight(bucket),
    average: bucketAverage(bucket),
    detailFields: BUCKET_DETAIL_FIELDS[bucket] ?? [],
}));

export const BIG_PICTURE_CATEGORIES = [
    'income',
    'debt_payment',
    'schooling',
    'insurance_health',
    'insurance_home',
    'insurance_auto',
    'insurance_other',
    'savings',
] as const;

export const MONTHLY_MULTIPLIER: Record<Frequency, number> = {
    monthly: 1,
    yearly: 1 / 12,
    weekly: 52 / 12,
};

export const RECENT_TRANSACTIONS = 100;
export const ADVICE_MONTHS = 6;

export const roundCents = (value: number) => Math.round(value * 100) / 100;
export const moneyText = (value: number) => value.toFixed(2);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const toNumber = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

export const isFrequency = (value: unknown): value is Frequency =>
    value === 'monthly' || value === 'yearly' || value === 'weekly';

export const asFrequency = (value: unknown): Frequency =>
    isFrequency(value) ? value : 'monthly';

export const isTrue = (value: unknown) =>
    value === true || value === 1 || String(value).toLowerCase() === 'true';

export function isoDay(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

// Text dates stay as they are. Date cells appear if someone edits in Excel,
// and Excel stores those as midnight UTC.
export function dayText(value: unknown): string {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);
}

export function isRealDay(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const perMonth = (row: { amount: unknown; frequency: unknown }) =>
    toNumber(row.amount) * MONTHLY_MULTIPLIER[asFrequency(row.frequency)];

function stamp(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    return String(value ?? '');
}

export function latest(values: Array<Date | string | null | undefined>): string | null {
    return values.reduce<string | null>((newest, value) => {
        const text = stamp(value);
        return text && (!newest || text > newest) ? text : newest;
    }, null);
}

export class PrototypeRequestError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

// How many chart points sit between two YYYY-MM-DD days, inclusive. Monthly
// points for the 6-month and year views, daily points for the week view, and
// weekly points for the month view. Gaps in the middle still count: a month
// (or day) with no spending still spent $0, it is not missing history.
function historyPoints(firstDay: string, lastDay: string, period: string): number {
    const parts = (day: string) => day.slice(0, 10).split('-').map(Number);
    const [fromY, fromM, fromD] = parts(firstDay);
    const [toY, toM, toD] = parts(lastDay);
    if (!fromY || !fromM || !fromD || !toY || !toM || !toD) return 1;

    if (period === 'week') {
        const fromUtc = Date.UTC(fromY, fromM - 1, fromD);
        const toUtc = Date.UTC(toY, toM - 1, toD);
        return Math.max(1, Math.round((toUtc - fromUtc) / 86_400_000) + 1);
    }

    if (period === 'month') {
        // Month points are weeks, so the average per point is per week.
        const fromUtc = Date.UTC(fromY, fromM - 1, fromD);
        const toUtc = Date.UTC(toY, toM - 1, toD);
        const daysSpan = Math.round((toUtc - fromUtc) / 86_400_000) + 1;
        return Math.max(1, Math.ceil(daysSpan / 7));
    }

    return Math.max(1, (toY * 12 + toM) - (fromY * 12 + fromM) + 1);
}

export type AdviceTone = 'good' | 'mixed' | 'warning' | 'none';

export type Advice = {
    tone: AdviceTone;
    headline: string;
    detail: string;
    // Follow-on read from the expense_weight.json importance weights
    // (1 = mostly unnecessary, 10 = almost unavoidable). Empty when no
    // spending history exists to measure.
    necessity: string;
};

// Turns the weighted necessity score into the sentence that sits under the
// main advice. Weights come from expense_weight.json: 10 is nearly
// unavoidable, 1 is mostly optional, and anything rated 3 or lower is framed
// as the easiest place to trim first.
function necessityLine(spentTotal: number, weightedSum: number, lowTotal: number, months: number): string {
    if (spentTotal <= 0 || months < 1) return '';

    const average = weightedSum / spentTotal;
    const base =
        `Scoring every purchase with the necessity weights from expense_weight.json ` +
        `(1 = mostly unnecessary, 10 = almost unavoidable), your recent spending averages ` +
        `${average.toFixed(1)} out of 10.`;

    const lowPerMonth = roundCents(lowTotal / months);
    const lowShare = Math.round((lowTotal / spentTotal) * 100);
    const lowBit = lowPerMonth >= 1
        ? ` About ${lowShare}% of it — ${usd.format(lowPerMonth)} a month — rates 3 or lower, which is both the easiest and the first place to trim when cash is short.`
        : ' Almost none of it sits in the 1–3 range, so savings are easier to find in the essentials plan itself than in small cuts.';

    const tag = average < 3.5
        ? ' An average that low means a lot of this spending is optional by design.'
        : average > 7
            ? ' An average that high means the big stuff is essentials, so start with the small rated-3-or-lower slice.'
            : '';

    return base + lowBit + tag;
}

// Hard-coded advice rules over the recent spending history. Only months with
// at least one transaction count: a month without purchases is missing
// history, not a month of perfect under-budget discipline.
export function advicePayload(transactions: TransactionRow[], monthlyBudget: number): Advice {
    if (transactions.length === 0) {
        return {
            tone: 'none',
            headline: 'No spending history yet',
            detail: 'Log a few transactions and advice will start building from your history.',
            necessity: '',
        };
    }

    const byMonth = new Map<string, number>();
    for (const row of transactions) {
        const key = dayText(row.spent_on).slice(0, 7);
        byMonth.set(key, (byMonth.get(key) ?? 0) + toNumber(row.amount));
    }
    const recent = [...byMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-ADVICE_MONTHS);
    const recentKeys = recent.map(([key]) => key);
    const recentRows = transactions
        .filter(row => recentKeys.includes(dayText(row.spent_on).slice(0, 7)));

    // Necessity read: every purchase is scored with the expense_weight.json
    // weight of its category, and the amounts behind the low ratings get
    // called out as the easiest trims. Works with or without a budget.
    let weightedSum = 0;
    let spentTotal = 0;
    let lowTotal = 0;
    for (const row of recentRows) {
        const amount = toNumber(row.amount);
        const weight = transactionWeight(String(row.category ?? ''), String(row.bucket ?? ''));
        weightedSum += amount * weight;
        spentTotal += amount;
        if (weight <= 3) lowTotal += amount;
    }
    const necessity = necessityLine(spentTotal, weightedSum, lowTotal, recent.length);

    if (monthlyBudget <= 0) {
        return {
            tone: 'none',
            headline: 'No budget to compare with yet',
            detail: 'Advice compares your spending with a budget. Set one up in the Big Picture planner (or set expected amounts in Monthly setup) to unlock it.',
            necessity,
        };
    }

    if (recent.length < 2) {
        return {
            tone: 'none',
            headline: 'Not enough history yet',
            detail: `There is only one month of spending so far. Keep logging purchases — advice gets sharper once two or more months can be compared with the ${usd.format(monthlyBudget)} budget.`,
            necessity,
        };
    }

    const over = recent.filter(([, total]) => total > monthlyBudget).length;
    const under = recent.length - over;
    const average = recent.reduce((sum, [, total]) => sum + total, 0) / recent.length;

    if (over === 0) {
        return {
            tone: 'good',
            headline: "You're doing great and could save more",
            detail: `Every one of the last ${recent.length} months landed under the ${usd.format(monthlyBudget)} budget, averaging ${usd.format(average)} a month. Consider moving the difference into savings or setting a tighter target.`,
            necessity,
        };
    }

    if (over * 3 >= recent.length * 2) {
        return {
            tone: 'warning',
            headline: 'Consistently breaking the budget',
            detail: `You went over budget in ${over} of the last ${recent.length} months, averaging ${usd.format(average)} against the ${usd.format(monthlyBudget)} budget. You should consider cutting back on spending or rethinking your savings plan.`,
            necessity,
        };
    }

    return {
        tone: 'mixed',
        headline: 'Spending is close to the budget',
        detail: `The last ${recent.length} months split ${under} under budget and ${over} over, averaging ${usd.format(average)} against the ${usd.format(monthlyBudget)} budget. Trimming your biggest categories on the over months would even this out.`,
        necessity,
    };
}

export function bigPictureTotals(entries: BigPictureRow[]) {
    const monthly = (category: string) => {
        const entry = entries.find(row => row.category === category);
        return entry ? perMonth(entry) : 0;
    };
    const income = monthly('income');
    const debtPayment = monthly('debt_payment');
    const schooling = monthly('schooling');
    // Insurance is planned as four rows on the dashboard; the aggregate is kept
    // for the recurring total and for older clients.
    const insuranceHealth = monthly('insurance_health');
    const insuranceHome = monthly('insurance_home');
    const insuranceAuto = monthly('insurance_auto');
    const insuranceOther = monthly('insurance_other');
    const insurance = insuranceHealth + insuranceHome + insuranceAuto + insuranceOther;
    const savings = monthly('savings');
    const recurring = debtPayment + schooling + insurance;
    return {
        income: roundCents(income),
        debt_payment: roundCents(debtPayment),
        schooling: roundCents(schooling),
        insurance: roundCents(insurance),
        insurance_health: roundCents(insuranceHealth),
        insurance_home: roundCents(insuranceHome),
        insurance_auto: roundCents(insuranceAuto),
        insurance_other: roundCents(insuranceOther),
        recurring: roundCents(recurring),
        savings: roundCents(savings),
        budget: roundCents(income - recurring - savings),
        configured: entries.some(row => toNumber(row.amount) > 0),
    };
}

// Big Picture budget while the planner is configured; otherwise the monthly
// setup total stands in. Feeds the stats points, the advice rules, and the
// category scaling.
export function monthlyBudgetFor(expenses: ExpenseRow[], totals: ReturnType<typeof bigPictureTotals>) {
    const setupMonthly = expenses.reduce((sum, row) => sum + perMonth(row), 0);
    return totals.configured ? Math.max(0, totals.budget) : setupMonthly;
}

export function profilePayload(data: ProfileData) {
    const { profile, expenses, transactions } = data;
    const thisMonth = isoDay(new Date()).slice(0, 7);
    const monthRows = transactions.filter(row => dayText(row.spent_on).startsWith(thisMonth));

    const monthly = BUCKETS.map(({ bucket, label }) => {
        const expense = expenses.find(row => row.category === bucket);
        const spent = monthRows.filter(row => row.bucket === bucket);
        return {
            bucket,
            label,
            expected: toNumber(expense?.amount),
            frequency: asFrequency(expense?.frequency),
            expectedMonthly: expense ? roundCents(perMonth(expense)) : 0,
            actual: roundCents(spent.reduce((sum, row) => sum + toNumber(row.amount), 0)),
            transactionCount: spent.length,
            detail: expense?.detail ?? {},
            updated_at: expense?.updated_at ?? null,
        };
    });

    const recent = [...transactions]
        .sort((a, b) =>
            dayText(b.spent_on).localeCompare(dayText(a.spent_on)) ||
            toNumber(b.transaction_id) - toNumber(a.transaction_id))
        .slice(0, RECENT_TRANSACTIONS);

    const bigTotals = bigPictureTotals(data.bigPicture);
    const monthlyBudget = monthlyBudgetFor(expenses, bigTotals);

    return {
        profile: {
            key: 'prototype',
            display_name: profile?.display_name || 'Prototype profile',
            category_count: expenses.filter(row => toNumber(row.amount) > 0).length,
            total_monthly: moneyText(monthly.reduce((sum, row) => sum + row.expectedMonthly, 0)),
            actual_month: moneyText(monthRows.reduce((sum, row) => sum + toNumber(row.amount), 0)),
            transaction_count: monthRows.length,
            updated_at: profile?.updated_at || latest([...expenses, ...data.bigPicture].map(row => row.updated_at)),
        },
        buckets: BUCKETS,
        monthly,
        advice: advicePayload(transactions, monthlyBudget),
        big_picture: {
            entries: data.bigPicture.map(row => ({
                category: row.category,
                amount: toNumber(row.amount),
                frequency: asFrequency(row.frequency),
            })),
            totals: bigTotals,
        },
        transactions: recent.map(row => ({
            id: row.transaction_id,
            category: row.category,
            bucket: row.bucket,
            amount: toNumber(row.amount),
            spent_on: dayText(row.spent_on),
            note: row.note ? String(row.note) : '',
            recurring: isTrue(row.recurring),
            created_at: row.created_at,
        })),
    };
}

export type StatsPeriod = 'week' | 'month' | 'six' | 'year';

export function statsPayload(data: ProfileData, requested: string | null) {
    const period: StatsPeriod =
        requested === 'week' || requested === 'month' || requested === 'year' ? requested : 'six';
    const expenses = data.expenses;
    const totals = bigPictureTotals(data.bigPicture);
    const monthlyBudget = monthlyBudgetFor(expenses, totals);
    const setupMonthly = expenses.reduce((sum, row) => sum + perMonth(row), 0);

    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const shortMonth = (date: Date) => date.toLocaleDateString('en-US', { month: 'short' });
    const points: { label: string; from: string; to: string; expected: number }[] = [];
    let from: Date;
    let to: Date;
    let label: string;
    let periodBudget: number;

    if (period === 'week') {
        // Monday through Sunday.
        from = new Date(year, month, today.getDate() - ((today.getDay() + 6) % 7));
        to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6);
        label = `${shortMonth(from)} ${from.getDate()} – ${shortMonth(to)} ${to.getDate()}, ${to.getFullYear()}`;
        periodBudget = (monthlyBudget * 12) / 52;
        for (let index = 0; index < 7; index += 1) {
            const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + index);
            points.push({
                label: date.toLocaleDateString('en-US', { weekday: 'short' }),
                from: isoDay(date),
                to: isoDay(date),
                expected: periodBudget / 7,
            });
        }
    } else if (period === 'month') {
        from = new Date(year, month, 1);
        to = new Date(year, month + 1, 0);
        label = today.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        periodBudget = monthlyBudget;
        // One bar per week instead of one per day. Weeks run Monday–Sunday
        // like the week view; the first and last weeks are clipped to the
        // month so the bars tile the month exactly. Each week's expected
        // slice of the budget is proportional to how many of the month's
        // days it covers.
        const daysInMonth = to.getDate();
        let weekStart = 1;
        while (weekStart <= daysInMonth) {
            const startDate = new Date(year, month, weekStart);
            const offset = (startDate.getDay() + 6) % 7; // days since Monday
            const weekEnd = Math.min(daysInMonth, weekStart + 6 - offset);
            const endDate = new Date(year, month, weekEnd);
            const weekDays = weekEnd - weekStart + 1;
            const endLabel = startDate.getDate() === endDate.getDate()
                ? ''
                : `–${endDate.getDate()}`;
            points.push({
                label: `${shortMonth(startDate)} ${startDate.getDate()}${endLabel}`,
                from: isoDay(startDate),
                to: isoDay(endDate),
                expected: (periodBudget * weekDays) / daysInMonth,
            });
            weekStart = weekEnd + 1;
        }
    } else if (period === 'six') {
        from = new Date(year, month - 5, 1);
        to = new Date(year, month + 1, 0);
        label = `${shortMonth(from)} ${from.getFullYear()} – ${shortMonth(to)} ${to.getFullYear()}`;
        periodBudget = monthlyBudget * 6;
        for (let index = 0; index < 6; index += 1) {
            const first = new Date(year, month - 5 + index, 1);
            points.push({
                label: shortMonth(first),
                from: isoDay(first),
                to: isoDay(new Date(first.getFullYear(), first.getMonth() + 1, 0)),
                expected: monthlyBudget,
            });
        }
    } else {
        from = new Date(year, 0, 1);
        to = new Date(year, 11, 31);
        label = String(year);
        periodBudget = monthlyBudget * 12;
        for (let index = 0; index < 12; index += 1) {
            const start = new Date(year, index, 1);
            points.push({
                label: shortMonth(start),
                from: isoDay(start),
                to: isoDay(new Date(year, index + 1, 0)),
                expected: monthlyBudget,
            });
        }
    }

    const start = isoDay(from);
    const end = isoDay(to);
    const allTransactions = data.transactions;
    const inPeriod = allTransactions.filter(row => {
        const day = dayText(row.spent_on);
        return day >= start && day <= end;
    });
    const sum = (rows: TransactionRow[]) => rows.reduce((total, row) => total + toNumber(row.amount), 0);

    const actual = sum(inPeriod);
    const recurring = sum(inPeriod.filter(row => isTrue(row.recurring)));
    const scale = setupMonthly > 0 ? periodBudget / setupMonthly : 0;

    // Average spending over the recorded history of the current year, so the
    // average line is one stable number no matter which period is selected.
    // The denominator runs from the first populated day/month of that history
    // to the nearest populated one, not the calendar: someone who starts
    // tracking mid-year is not diluted by the empty months before their first
    // transaction, and the current month counts once anything is logged in it.
    const yearStartDay = isoDay(new Date(year, 0, 1));
    const yearRows = allTransactions.filter(row => dayText(row.spent_on) >= yearStartDay);
    const yearDays = yearRows.map(row => dayText(row.spent_on)).sort();
    const firstDay = yearDays[0];
    const lastDay = yearDays[yearDays.length - 1];
    const yearlyAverage = firstDay && lastDay
        ? roundCents(sum(yearRows) / historyPoints(firstDay, lastDay, period))
        : 0;

    return {
        period,
        range: { label, from: start, to: end },
        series: points.map(point => ({
            label: point.label,
            total: roundCents(sum(inPeriod.filter(row => {
                const day = dayText(row.spent_on);
                return day >= point.from && day <= point.to;
            }))),
            expected: roundCents(point.expected),
        })),
        categories: BUCKETS.map(({ bucket, label: bucketLabel }) => {
            const expense = expenses.find(row => row.category === bucket);
            const spent = sum(inPeriod.filter(row => row.bucket === bucket));
            const expected = expense ? perMonth(expense) * scale : 0;
            return {
                bucket,
                label: bucketLabel,
                actual: roundCents(spent),
                expected: roundCents(expected),
                difference: roundCents(spent - expected),
            };
        }),
        totals: {
            actual: roundCents(actual),
            expected: roundCents(periodBudget),
            difference: roundCents(actual - periodBudget),
            transactionCount: inPeriod.length,
            budgetSource: totals.configured ? 'big_picture' : 'monthly_setup',
            recurring: roundCents(recurring),
            oneTime: roundCents(actual - recurring),
            recurringShare: actual > 0 ? recurring / actual : 0,
            yearlyAverage,
        },
    };
}
