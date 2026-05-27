import { registerDialect } from '../dialect';
import { postgresDialect } from './postgres';

registerDialect(postgresDialect);

// Future dialects register here: registerDialect(mysqlDialect); etc.
