import './config';

import { Module } from '@nestjs/common';

import { ServerConfigModule } from '../../core/config';
// `DocLinksReader` is registered here (rather than `core/doc`'s
// `DocStorageModule`) because it depends on `IndexerService`; importing it
// from `core/doc/index.ts` would close an import cycle back through
// `core/index.ts` -> `core/auth` -> `core/doc`. It's still defined alongside
// the other doc readers/writers in `core/doc/doc-links-reader.ts`.
import { DocLinksReader } from '../../core/doc/doc-links-reader';
import { PermissionModule } from '../../core/permission';
import { QuotaServiceModule } from '../../core/quota';
import { IndexerEvent } from './event';
import { SearchProviderFactory } from './factory';
import { IndexerJob } from './job';
import { SearchProviders } from './providers';
import { IndexerResolver } from './resolver';
import { IndexerService } from './service';

@Module({
  imports: [ServerConfigModule, PermissionModule, QuotaServiceModule],
  providers: [
    IndexerResolver,
    IndexerService,
    IndexerJob,
    IndexerEvent,
    SearchProviderFactory,
    ...SearchProviders,
    DocLinksReader,
  ],
  exports: [IndexerService, SearchProviderFactory, DocLinksReader],
})
export class IndexerModule {}

export { DocLinksReader, IndexerService };
export type { SearchDoc } from './types';
