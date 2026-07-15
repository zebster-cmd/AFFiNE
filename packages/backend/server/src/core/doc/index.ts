import './config';

import { Module } from '@nestjs/common';

import { BackendRuntimeModule } from '../backend-runtime';
import { PermissionModule } from '../permission';
import { QuotaModule } from '../quota';
import { StorageModule } from '../storage';
import { PgUserspaceDocStorageAdapter } from './adapters/userspace';
import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';
import { DatabaseWriter } from './database-writer';
import { DocLinksWriter } from './doc-links-writer';
import { DocPropertiesReader } from './doc-properties-reader';
import { DocPropertiesWriter } from './doc-properties-writer';
import { DocEventsListener } from './event';
import { DocStorageCronJob } from './job';
import { DocStorageOptions } from './options';
import { DatabaseDocReader, DocReader, DocReaderProvider } from './reader';
import { DocWriter } from './writer';

@Module({
  imports: [BackendRuntimeModule, QuotaModule, PermissionModule, StorageModule],
  providers: [
    DocStorageOptions,
    PgWorkspaceDocStorageAdapter,
    PgUserspaceDocStorageAdapter,
    DocStorageCronJob,
    DocReaderProvider,
    DatabaseDocReader,
    DocEventsListener,
    DocWriter,
    DatabaseWriter,
    DocPropertiesReader,
    DocPropertiesWriter,
    DocLinksWriter,
  ],
  exports: [
    DatabaseDocReader,
    DocReader,
    DocWriter,
    DatabaseWriter,
    PgWorkspaceDocStorageAdapter,
    PgUserspaceDocStorageAdapter,
    DocPropertiesReader,
    DocPropertiesWriter,
    DocLinksWriter,
  ],
})
export class DocStorageModule {}
export {
  // only for doc-service
  DatabaseDocReader,
  DocReader,
  DocWriter,
  PgUserspaceDocStorageAdapter,
  PgWorkspaceDocStorageAdapter,
};

export {
  DatabaseReader,
  listBoardsFromBinary,
  readBoardFromBinary,
} from './database-reader';
export { DatabaseWriter } from './database-writer';
export { DocLinksWriter } from './doc-links-writer';
export { DocPropertiesReader } from './doc-properties-reader';
export { DocPropertiesWriter } from './doc-properties-writer';
export { DocStorageAdapter, type Editor } from './storage';
