import { Dataset } from 'crawlee';

async function exportData() {
    const dataset = await Dataset.open();
    await dataset.exportToCSV('jobs_export.csv');
    console.log('Exported to jobs_export.csv');
}

exportData().catch(console.error);
