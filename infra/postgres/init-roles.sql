-- Papéis do serviço. Executado uma vez, pelo superusuário, na inicialização do container.
-- wagering_owner: dono do schema, roda as migrations.
-- wagering_app: runtime; só SELECT/INSERT/UPDATE nas tabelas (DELETE e UPDATE do ledger são barrados na Tarefa 6).

CREATE ROLE wagering_owner LOGIN PASSWORD 'owner';
CREATE ROLE wagering_app LOGIN PASSWORD 'app';

ALTER DATABASE wagering OWNER TO wagering_owner;
ALTER SCHEMA public OWNER TO wagering_owner;

GRANT CONNECT ON DATABASE wagering TO wagering_app;
GRANT USAGE ON SCHEMA public TO wagering_app;

ALTER DEFAULT PRIVILEGES FOR ROLE wagering_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO wagering_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wagering_owner IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO wagering_app;
