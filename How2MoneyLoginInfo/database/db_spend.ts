// Spend windows and shared shapes.
//
// The entries themselves live in MongoDB (database/mongo_spend.ts). This file
// only keeps the calendar maths and the types both sides share.

export type Period = 'week' | 'month';

export type SpendEntryInput = {
    category: string;
    amount: number;
};

export type StoredSpendEntry = {
    category: string;
    amount: string;
    period: string;
    period_start: string;
    period_end: string;
    created_at: Date;
};

export type PeriodWindow = {
    start: string;
    end: string;
};

function toDateString(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// The window a period covers. "week" is the seven days starting on the next
// Monday (today, if today is a Monday). "month" is next calendar month.
export function nextPeriodWindow(period: Period): PeriodWindow {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (period === 'month') {
        const start = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        const end = new Date(today.getFullYear(), today.getMonth() + 2, 0);
        return { start: toDateString(start), end: toDateString(end) };
    }

    // getDay() is 0 for Sunday, so shift it round to make Monday 0.
    const daysSinceMonday = (today.getDay() + 6) % 7;
    const start = new Date(today);
    start.setDate(start.getDate() + (7 - daysSinceMonday) % 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start: toDateString(start), end: toDateString(end) };
}
