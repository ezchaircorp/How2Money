// One-off connection test for db_mongo.ts with the real link. Deleted after use.
import { getDb, closeMongo } from './database/db_mongo';

getDb()
    .then(async (db) => {
        console.log('connected — database:', db.databaseName);
        await db.command({ ping: 1 });
        console.log('ping ok');
        const cols = await db.listCollections().toArray();
        console.log('collections:', cols.map((c) => c.name).join(', ') || '(none yet)');
    })
    .catch((err) => {
        console.error('connection failed:', (err as Error).name, '—', (err as Error).message.split('URI')[0]);
    })
    .finally(async () => {
        await closeMongo();
        process.exit(0);
    });
