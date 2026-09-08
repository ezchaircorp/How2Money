import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

export const rl = createInterface({
    input,
    output
});
