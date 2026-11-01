-- AVISO: somente desenvolvimento local. As senhas vêm das variáveis WAGERING_OWNER_PASSWORD
-- e WAGERING_APP_PASSWORD (defaults de dev no docker-compose). Não use este init em produção.
--
-- Papéis do serviço. Executado uma vez, pelo superusuário, na inicialização do container.
-- wagering_owner: dono do schema, roda as migrations.
-- wagering_app: runtime; só SELECT/INSERT/UPDATE nas tabelas (DELETE e UPDATE do ledger são barrados na Tarefa 6).

-- \getenv (psql 15+) lê a senha do ambiente do container, sem literal no arquivo.
\getenv owner_pw WAGERING_OWNER_PASSWORD
\getenv app_pw WAGERING_APP_PASSWORD

CREATE ROLE wagering_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE wagering_app LOGIN PASSWORD :'app_pw';

ALTER DATABASE wagering OWNER TO wagering_owner;
ALTER SCHEMA public OWNER TO wagering_owner;

GRANT CONNECT ON DATABASE wagering TO wagering_app;
GRANT USAGE ON SCHEMA public TO wagering_app;

ALTER DEFAULT PRIVILEGES FOR ROLE wagering_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO wagering_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wagering_owner IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO wagering_app;
