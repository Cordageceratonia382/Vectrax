import { playBannerReaction } from '../../src/ui/banner.js';

await playBannerReaction({ version: '0.0.0', columns: 80 });
process.stderr.write('SETTLED\n');
