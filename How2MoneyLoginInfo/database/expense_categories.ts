// Expense categories.
//
// expense_weight.json at the repo root is the source of truth for the spending
// categories and their importance weights (1 = mostly unnecessary, 10 = almost
// unavoidable). The assessment form asks about 11 broader buckets instead, so
// this file also holds the mapping between the two, plus the per-bucket
// breakdown fields the form submits.

import fs from 'fs';
import path from 'path';
import { pool } from './db_con';

export type ExpenseCategory = {
    expense: string;
    description: string;
    val: number;
    cost_per_month: number;
    estimated: boolean;
};

// Walk up from this file until we find expense_weight.json. Works whether the
// app is run from the repo or from the Docker image (/app/How2MoneyLoginInfo).
function findWeightFile(): string {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, 'expense_weight.json');
        if (fs.existsSync(candidate)) return candidate;
        dir = path.dirname(dir);
    }
    throw new Error(
        'Could not find expense_weight.json. It is expected at the repo root, one or two levels above How2MoneyLoginInfo/.'
    );
}

let cached: ExpenseCategory[] | null = null;

export function loadExpenseCategories(): ExpenseCategory[] {
    if (cached) return cached;
    const raw = fs.readFileSync(findWeightFile(), 'utf8');
    const parsed = JSON.parse(raw) as ExpenseCategory[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('expense_weight.json did not contain a non-empty array.');
    }
    cached = parsed;
    return parsed;
}

// The 11 buckets the assessment form asks about, mapped to the canonical
// categories from expense_weight.json. Every one of the 21 categories is
// covered exactly once.
export const FORM_BUCKETS: Record<string, string[]> = {
    housing: ['Housing', 'Utilities'],
    transportation: ['Transportation', 'Gas & Fuel', 'Auto & Vehicle'],
    food: ['Groceries', 'Dining & Restaurants'],
    travel: ['Travel'],
    subscriptions_entertainment: ['Subscriptions & Services', 'Entertainment', 'Games & Gaming'],
    shopping: ['Shopping'],
    health_self_care: ['Healthcare', 'Fitness & Wellness', 'Personal Care'],
    education: ['Education'],
    work_professional: ['Work & Professional'],
    family_pets: ['Family', 'Pets', 'Gifts & Donations'],
    household: ['Household'],
};

// Human-readable names for the form buckets.
export const BUCKET_LABELS: Record<string, string> = {
    housing: 'Housing',
    transportation: 'Transportation',
    food: 'Food',
    travel: 'Travel',
    subscriptions_entertainment: 'Subscriptions & Entertainment',
    shopping: 'Shopping',
    health_self_care: 'Health & Self-Care',
    education: 'Education',
    work_professional: 'Work & Professional',
    family_pets: 'Family & Pets',
    household: 'Household',
};

// The optional "break it down further" inputs that belong to each bucket.
// Note the pets breakdown fields aren't prefixed with the bucket name, so
// these have to be listed explicitly rather than derived.
export const BUCKET_DETAIL_FIELDS: Record<string, string[]> = {
    housing: [
        'expense_housing_rent',
        'expense_housing_taxes',
        'expense_housing_repairs',
        'expense_housing_utilities',
    ],
    transportation: [
        'expense_transportation_gas',
        'expense_transportation_transit',
        'expense_transportation_auto',
    ],
    food: ['expense_food_groceries', 'expense_food_restaurants', 'expense_food_fast_food'],
    travel: [],
    subscriptions_entertainment: [
        'expense_subscriptions_entertainment_recurring',
        'expense_subscriptions_entertainment_onetime',
    ],
    shopping: [],
    health_self_care: [],
    education: [],
    work_professional: [],
    family_pets: [
        'expense_family_childcare',
        'expense_family_kids',
        'expense_family_support',
        'expense_pets_food',
        'expense_pets_vet',
        'expense_pets_grooming',
    ],
    household: [],
};

export function bucketAmountField(bucket: string): string {
    return `expense_${bucket}`;
}

export function bucketFrequencyField(bucket: string): string {
    return `expense_${bucket}_freq`;
}

// How many times a bucket's amount happens in a year, used to turn yearly or
// weekly figures into a monthly one.
const PERIODS_PER_YEAR: Record<string, number> = {
    monthly: 12,
    yearly: 1,
    weekly: 52,
};

export function monthlyMultiplier(frequency: string): number {
    const periods = PERIODS_PER_YEAR[frequency] ?? 12;
    return periods / 12;
}

// The typical monthly spend for a form bucket, summed from the canonical
// categories it covers. Used as the budget baseline.
export function bucketAverage(bucket: string): number {
    const categories = FORM_BUCKETS[bucket] ?? [];
    const all = loadExpenseCategories();
    return categories.reduce((sum, name) => {
        const found = all.find(c => c.expense === name);
        return sum + (found?.cost_per_month ?? 0);
    }, 0);
}

// The importance weight for a bucket: the average of the weights of the
// categories it covers, rounded to the nearest whole number.
export function bucketWeight(bucket: string): number {
    const categories = FORM_BUCKETS[bucket] ?? [];
    const all = loadExpenseCategories();
    if (categories.length === 0) return 0;
    const total = categories.reduce((sum, name) => {
        const found = all.find(c => c.expense === name);
        return sum + (found?.val ?? 0);
    }, 0);
    return Math.round(total / categories.length);
}

// Which expense_weight.json entry each fine-grained dashboard transaction
// category measures against. Buckets without detail fields fall through to
// bucketWeight instead.
const DETAIL_WEIGHTS: Record<string, string> = {
    expense_housing_rent: 'Housing',
    expense_housing_taxes: 'Housing',
    expense_housing_repairs: 'Housing',
    expense_housing_utilities: 'Utilities',
    expense_transportation_gas: 'Gas & Fuel',
    expense_transportation_transit: 'Transportation',
    expense_transportation_auto: 'Auto & Vehicle',
    expense_food_groceries: 'Groceries',
    expense_food_restaurants: 'Dining & Restaurants',
    expense_food_fast_food: 'Fast Food & Delivery',
    expense_subscriptions_entertainment_recurring: 'Subscriptions & Services',
    expense_subscriptions_entertainment_onetime: 'Entertainment',
    expense_family_childcare: 'Family',
    expense_family_kids: 'Family',
    expense_family_support: 'Child Support',
    expense_pets_food: 'Pets',
    expense_pets_vet: 'Pets',
    expense_pets_grooming: 'Pets',
};

// Necessity weight (1–10) for one logged transaction. Detail fields look up
// their specific entry; plain bucket categories use the bucket average.
// Anything unmapped lands on 5, the middle of the scale.
export function transactionWeight(category: string, bucket: string): number {
    const named = DETAIL_WEIGHTS[category];
    const all = loadExpenseCategories();
    if (named) {
        const found = all.find(c => c.expense === named);
        if (found) return found.val;
    }
    return bucketWeight(bucket) || 5;
}

// Push expense_weight.json into the expense_categories table so the API and
// the Rust engine read the same numbers. Safe to call on every start.
export async function syncExpenseCategories(): Promise<void> {
    const categories = loadExpenseCategories();

    for (const c of categories) {
        await pool.query(
            `INSERT INTO expense_categories (category, weight, avg_monthly)
             VALUES ($1, $2, $3)
             ON CONFLICT (category) DO UPDATE
             SET weight = EXCLUDED.weight,
                 avg_monthly = EXCLUDED.avg_monthly,
                 updated_at = now()`,
            [c.expense, c.val, c.cost_per_month]
        );
    }
}
